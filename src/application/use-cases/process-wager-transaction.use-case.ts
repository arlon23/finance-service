import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import {
  UniqueConstraintViolationException,
  type EntityManager,
} from '@mikro-orm/core';
import {
  OUTBOX_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_LEDGER_REPOSITORY,
  WALLET_REPOSITORY,
} from '../tokens.js';
import { calculateWagerPayloadHash } from '../payload-hash.js';
import type {
  OutboxRepositoryPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/financial-persistence.js';
import { DomainError } from '../../domain/domain-error.js';
import { FailureCode } from '../../domain/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event.js';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event.js';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event.js';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event.js';
import { correlationContext } from '../../infrastructure/logging/correlation-context.js';
import { FinancialMetricsService } from '../../infrastructure/metrics/financial-metrics.service.js';

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  walletBalance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      current instanceof UniqueConstraintViolationException &&
      /wager_transactions_idempotency_key_uq|wager_transactions_idempotency_key_key/i.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY)
    private readonly wallets: WalletRepositoryPort,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepositoryPort,
    @Inject(WALLET_LEDGER_REPOSITORY)
    private readonly ledger: WalletLedgerRepositoryPort,
    @Inject(OUTBOX_REPOSITORY)
    private readonly outbox: OutboxRepositoryPort,
    @Optional()
    private readonly metrics?: FinancialMetricsService,
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
    idempotencyKey?: string,
    transactionalEm?: EntityManager,
  ): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    try {
      const result = await this.executeInternal(
        input,
        idempotencyKey,
        transactionalEm,
      );
      if (!transactionalEm) {
        this.recordResultMetrics(result);
      }
      return result;
    } catch (error) {
      this.metrics?.recordTransaction(input?.kind ?? 'UNKNOWN', 'FAILED');
      if (error instanceof DomainError) {
        this.metrics?.recordBusinessFailure(error.failureCode);
      }
      throw error;
    } finally {
      if (!transactionalEm) {
        this.metrics?.observeProcessingDuration(
          input?.kind ?? 'UNKNOWN',
          (performance.now() - startedAt) / 1_000,
        );
      }
    }
  }

  private async executeInternal(
    input: ProcessWagerTransactionInput,
    idempotencyKey?: string,
    transactionalEm?: EntityManager,
  ): Promise<ProcessWagerTransactionResult> {
    const key = this.validateInput(
      input,
      idempotencyKey ?? input?.idempotencyKey,
    );
    const payloadHash = calculateWagerPayloadHash(input);

    const processInTransaction = async (
      em: EntityManager,
    ): Promise<ProcessWagerTransactionResult> => {
      const existing = await this.transactions.findByIdempotencyKey(key, em);
      if (existing) {
        return this.replay(existing, payloadHash);
      }
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        idempotencyKey: key,
        payloadHash,
        kind: input.kind,
        money: Money.from({
          amount: input.amount,
          currency: input.currency,
        }),
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });
      return this.process(
        transaction,
        em,
        false,
        correlationContext.get()?.correlationId ?? input.correlationId,
        input.causationId,
      );
    };

    if (transactionalEm) {
      return processInTransaction(transactionalEm);
    }

    try {
      return await this.em.transactional(processInTransaction);
    } catch (error) {
      if (!isIdempotencyUniqueViolation(error)) {
        throw error;
      }
      const lookupEm = this.em.fork({ clear: true });
      const existing = await this.transactions.findByIdempotencyKey(
        key,
        lookupEm,
      );
      if (!existing) {
        throw error;
      }
      return this.replay(existing, payloadHash);
    }
  }

  async reprocessPending(
    transactionId: string,
  ): Promise<ProcessWagerTransactionResult | null> {
    const startedAt = performance.now();
    let kind: WagerTransactionKind | 'UNKNOWN' = 'UNKNOWN';
    try {
      const result = await this.em.transactional(async (em) => {
        const transaction = await this.transactions.findById(transactionId, em);
        if (!transaction) {
          throw new DomainError(
            FailureCode.TRANSACTION_NOT_FOUND,
            'Transaction does not exist',
          );
        }
        if (transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) {
          return null;
        }
        kind = transaction.kind;
        return this.process(transaction, em, false);
      });
      if (result) {
        this.recordResultMetrics(result);
      }
      return result;
    } catch (error) {
      this.metrics?.recordTransaction(kind, 'FAILED');
      if (error instanceof DomainError) {
        this.metrics?.recordBusinessFailure(error.failureCode);
      }
      throw error;
    } finally {
      this.metrics?.observeProcessingDuration(
        kind,
        (performance.now() - startedAt) / 1_000,
      );
    }
  }

  private async process(
    transaction: WagerTransaction,
    em: EntityManager,
    isReplay: boolean,
    correlationId = correlationContext.get()?.correlationId ?? transaction.id,
    causationId?: string,
  ): Promise<ProcessWagerTransactionResult> {
    return this.processTransaction(
      transaction,
      em,
      isReplay,
      correlationId,
      causationId,
    );
  }

  private async processTransaction(
    transaction: WagerTransaction,
    em: EntityManager,
    isReplay: boolean,
    correlationId = correlationContext.get()?.correlationId ?? transaction.id,
    causationId?: string,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await this.wallets.findById(transaction.walletId, {
      lock: true,
      em,
    });
    if (!wallet) {
      throw new DomainError(
        FailureCode.WALLET_NOT_FOUND,
        'Wallet does not exist',
      );
    }
    correlationContext.setAggregateId(wallet.id);

    const reference = transaction.referenceExternalTransactionId
      ? await this.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
          em,
        )
      : undefined;
    const reversals = transaction.referenceExternalTransactionId
      ? await this.transactions.findReversals(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
          transaction.kind,
          em,
        )
      : [];
    const entry = transaction.process(wallet, {
      ledgerEntryId: randomUUID(),
      reference,
      existingReversals: reversals,
    });
    transaction.recordResultingBalance(wallet.balance);

    await this.transactions.save(transaction, em);
    if (entry) {
      await this.wallets.save(wallet, em);
      await this.ledger.save(entry, em);
    }
    const metadata = {
      eventId: randomUUID(),
      aggregateId: wallet.id,
      correlationId,
      occurredAt: transaction.updatedAt,
      ...(causationId ? { causationId } : {}),
    };
    if (transaction.status === WagerTransactionStatus.PROCESSED) {
      const processedEvent = new WagerTransactionProcessed(metadata, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: wallet.id,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        resultingBalance: wallet.balance.toJSON(),
        ...(transaction.referenceExternalTransactionId
          ? {
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,
            }
          : {}),
      });
      await this.outbox.save(
        {
          id: processedEvent.eventId,
          aggregateId: processedEvent.aggregateId,
          eventType: processedEvent.eventType,
          occurredAt: processedEvent.occurredAt,
          payload: { ...processedEvent.toJSON() },
        },
        em,
      );
      if (entry) {
        const balanceChangedEvent = new WalletBalanceChanged(
          {
            ...metadata,
            eventId: randomUUID(),
            correlationId: processedEvent.correlationId,
          },
          {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        );
        await this.outbox.save(
          {
            id: balanceChangedEvent.eventId,
            aggregateId: balanceChangedEvent.aggregateId,
            eventType: balanceChangedEvent.eventType,
            occurredAt: balanceChangedEvent.occurredAt,
            payload: { ...balanceChangedEvent.toJSON() },
          },
          em,
        );
      }
    } else if (transaction.status === WagerTransactionStatus.REJECTED) {
      if (!transaction.failureCode) {
        throw new DomainError(
          FailureCode.INVALID_TRANSACTION_STATE,
          'Rejected transaction must include a failure code',
        );
      }
      const rejectedEvent = new WagerTransactionRejected(metadata, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: wallet.id,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      });
      await this.outbox.save(
        {
          id: rejectedEvent.eventId,
          aggregateId: rejectedEvent.aggregateId,
          eventType: rejectedEvent.eventType,
          occurredAt: rejectedEvent.occurredAt,
          payload: { ...rejectedEvent.toJSON() },
        },
        em,
      );
    } else if (
      transaction.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      if (!transaction.referenceExternalTransactionId) {
        throw new DomainError(
          FailureCode.INVALID_TRANSACTION_STATE,
          'Pending-reference transaction must include its reference id',
        );
      }
      const pendingEvent = new WagerTransactionPendingReference(metadata, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        playerId: transaction.playerId,
        walletId: wallet.id,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
      });
      await this.outbox.save(
        {
          id: pendingEvent.eventId,
          aggregateId: pendingEvent.aggregateId,
          eventType: pendingEvent.eventType,
          occurredAt: pendingEvent.occurredAt,
          payload: { ...pendingEvent.toJSON() },
        },
        em,
      );
    } else {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        `Cannot publish an event for transaction status ${transaction.status}`,
      );
    }
    return this.result(transaction, wallet.balance, isReplay);
  }

  private replay(
    transaction: WagerTransaction,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (!transaction.matchesPayload(payloadHash)) {
      throw new DomainError(
        FailureCode.IDEMPOTENCY_CONFLICT,
        'Idempotency-Key was already used with a different payload',
      );
    }
    if (!transaction.resultingBalance) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Persisted transaction does not contain its original response balance',
      );
    }
    return this.result(transaction, transaction.resultingBalance, true);
  }

  private result(
    transaction: WagerTransaction,
    balance: Money,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transaction,
      walletBalance: balance.toJSON(),
      idempotentReplay,
    };
  }

  private recordResultMetrics(result: ProcessWagerTransactionResult): void {
    if (result.idempotentReplay) {
      return;
    }
    const transaction = result.transaction;
    if (transaction.status === WagerTransactionStatus.PROCESSED) {
      this.metrics?.recordTransaction(transaction.kind, 'SUCCESS');
    } else if (transaction.status === WagerTransactionStatus.REJECTED) {
      this.metrics?.recordTransaction(transaction.kind, 'REJECTED');
      if (transaction.failureCode) {
        this.metrics?.recordBusinessFailure(transaction.failureCode);
      }
    }
  }

  private validateInput(
    input: ProcessWagerTransactionInput | undefined,
    idempotencyKey: string | undefined,
  ): string {
    if (
      !input ||
      [
        input.providerId,
        input.externalTransactionId,
        input.playerId,
        input.walletId,
        input.roundId,
        input.gameId,
        input.currency,
        input.amount,
      ].some((value) => typeof value !== 'string' || !value.trim()) ||
      (input.correlationId !== undefined && !input.correlationId.trim()) ||
      (input.causationId !== undefined && !input.causationId.trim()) ||
      input.providerId.includes(':') ||
      input.externalTransactionId.includes(':') ||
      !Object.values(WagerTransactionKind).includes(input.kind) ||
      input.kind === WagerTransactionKind.OPENING ||
      (input.referenceExternalTransactionId !== undefined &&
        (!input.referenceExternalTransactionId.trim() ||
          input.referenceExternalTransactionId === input.externalTransactionId))
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Transaction payload is invalid or uses a reserved operation kind',
      );
    }
    const expectedKey = `${input.providerId}:${input.externalTransactionId}`;
    if (!idempotencyKey || idempotencyKey !== expectedKey) {
      throw new DomainError(
        FailureCode.INVALID_IDEMPOTENCY_KEY,
        'Idempotency-Key must match {providerId}:{externalTransactionId}',
      );
    }
    if (
      [WagerTransactionKind.REFUND, WagerTransactionKind.ROLLBACK].includes(
        input.kind,
      ) &&
      !input.referenceExternalTransactionId
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        `${input.kind} transactions require a reference`,
      );
    }
    Money.from({ amount: input.amount, currency: input.currency });
    return idempotencyKey;
  }
}
