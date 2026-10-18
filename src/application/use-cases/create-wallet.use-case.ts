import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
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
import { Wallet } from '../../domain/aggregates/wallet.js';
import { DomainError } from '../../domain/domain-error.js';
import { FailureCode } from '../../domain/failure-code.js';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { correlationContext } from '../../infrastructure/logging/correlation-context.js';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance: string;
  id?: string;
}

export interface CreateWalletResult {
  wallet: Wallet;
  openingTransaction?: WagerTransaction;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      current instanceof UniqueConstraintViolationException &&
      /wallets_player_currency_uq|wallets_player_id_currency_key/i.test(
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
export class CreateWalletUseCase {
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
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    if (
      !input ||
      typeof input.playerId !== 'string' ||
      input.playerId.trim().length === 0
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Wallet playerId is required',
      );
    }
    const initialBalance = Money.from({
      amount: input.initialBalance,
      currency: input.currency,
    });

    try {
      return await this.em.transactional(async (em) => {
        const existing = await this.wallets.findByPlayerAndCurrency(
          input.playerId,
          input.currency,
          em,
        );
        if (existing) {
          throw new DomainError(
            FailureCode.WALLET_ALREADY_EXISTS,
            'A wallet already exists for this player and currency',
          );
        }

        const wallet = Wallet.open({
          id: input.id ?? randomUUID(),
          playerId: input.playerId,
          initialBalance: Money.zero(input.currency),
        });
        correlationContext.setAggregateId(wallet.id);
        let openingTransaction: WagerTransaction | undefined;
        let openingEntry: WalletLedgerEntry | null = null;
        if (initialBalance.isPositive()) {
          const providerId = 'internal-wallet';
          const externalTransactionId = `opening-${wallet.id}`;
          openingTransaction = WagerTransaction.create({
            id: randomUUID(),
            providerId,
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'wallet-opening',
            gameId: 'wallet-opening',
            idempotencyKey: `${providerId}:${externalTransactionId}`,
            payloadHash: calculateWagerPayloadHash({
              providerId,
              externalTransactionId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: 'wallet-opening',
              gameId: 'wallet-opening',
              kind: WagerTransactionKind.OPENING,
              amount: input.initialBalance,
              currency: input.currency,
            }),
            kind: WagerTransactionKind.OPENING,
            money: initialBalance,
          });
          openingEntry = openingTransaction.process(wallet, {
            ledgerEntryId: randomUUID(),
          });
          openingTransaction.recordResultingBalance(wallet.balance);
        }

        await this.wallets.save(wallet, em);
        if (openingTransaction && openingEntry) {
          await this.transactions.save(openingTransaction, em);
          await this.ledger.save(openingEntry, em);
        }
        await this.outbox.save(
          {
            id: randomUUID(),
            aggregateId: wallet.id,
            eventType: 'WalletOpened',
            payload: {
              walletId: wallet.id,
              playerId: wallet.playerId,
              currency: wallet.currency,
              balance: wallet.balance.toJSON(),
              openingTransactionId: openingTransaction?.id ?? null,
              correlationId:
                correlationContext.get()?.correlationId ?? randomUUID(),
            },
          },
          em,
        );
        return { wallet, openingTransaction };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          FailureCode.WALLET_ALREADY_EXISTS,
          'A wallet already exists for this player and currency',
        );
      }
      throw error;
    }
  }
}
