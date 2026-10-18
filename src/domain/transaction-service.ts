import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './domain-error.js';
import { FailureCode } from './failure-code.js';
import type {
  FinancialRepository,
  FinancialUnitOfWork,
} from './financial-repository.js';
import { IdempotencyKeyAlreadyClaimedError } from './financial-repository.js';
import {
  assertCurrency,
  canonicalAmount,
  LedgerEntryType,
  fromMinorUnits,
  TransactionOperation,
  TransactionStatus,
  toMinorUnits,
  transitionTransaction,
  type LedgerEntry,
  type TransactionCommand,
  type TransactionRecord,
} from './transaction.js';

export interface TransactionResult {
  transaction: TransactionRecord;
  idempotentReplay: boolean;
}

const businessFields = [
  'amount',
  'currency',
  'externalTransactionId',
  'operation',
  'playerId',
  'providerId',
  'referenceExternalTransactionId',
  'roundId',
  'walletId',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeJson(value: unknown): string {
  return canonicalJson(value);
}

export function calculatePayloadHash(command: TransactionCommand): string {
  const payload = Object.fromEntries(
    businessFields.map((key) => [
      key,
      key === 'amount'
        ? canonicalAmount(command.amount)
        : (command[key] ?? null),
    ]),
  );
  return createHash('sha256').update(canonicalizeJson(payload)).digest('hex');
}

function parseCommand(value: unknown): TransactionCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Request body must be an object',
    );
  }

  const command = value as Partial<TransactionCommand>;
  if (
    !isNonEmptyString(command.providerId) ||
    !isNonEmptyString(command.externalTransactionId) ||
    !isNonEmptyString(command.playerId) ||
    !isNonEmptyString(command.walletId) ||
    !isNonEmptyString(command.currency) ||
    !isNonEmptyString(command.roundId) ||
    [command.providerId, command.externalTransactionId].some((field) =>
      field?.includes(':'),
    ) ||
    command.referenceExternalTransactionId === command.externalTransactionId ||
    !Object.values(TransactionOperation).includes(
      command.operation as TransactionOperation,
    ) ||
    typeof command.amount !== 'string' ||
    ([TransactionOperation.REFUND, TransactionOperation.ROLLBACK].includes(
      command.operation as TransactionOperation,
    ) &&
      (typeof command.referenceExternalTransactionId !== 'string' ||
        command.referenceExternalTransactionId.trim().length === 0)) ||
    (command.referenceExternalTransactionId !== undefined &&
      !isNonEmptyString(command.referenceExternalTransactionId))
  ) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Request body does not match the transaction contract',
    );
  }

  assertCurrency(command.currency);
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    currency: command.currency,
    roundId: command.roundId,
    operation: command.operation as TransactionOperation,
    amount: canonicalAmount(command.amount),
    ...(command.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            command.referenceExternalTransactionId,
        }
      : {}),
  };
}

export class TransactionService {
  constructor(private readonly repository: FinancialRepository) {}

  async process(
    input: unknown,
    idempotencyKey: string | undefined,
  ): Promise<TransactionResult> {
    const command = parseCommand(input);
    const expectedKey = `${command.providerId}:${command.externalTransactionId}`;
    if (!idempotencyKey || idempotencyKey !== expectedKey) {
      throw new DomainError(
        FailureCode.INVALID_IDEMPOTENCY_KEY,
        'Idempotency-Key must match {providerId}:{externalTransactionId}',
      );
    }

    const payloadHash = calculatePayloadHash(command);
    try {
      return await this.repository.withTransaction(async (unitOfWork) => {
        const existing =
          await unitOfWork.findTransactionByIdempotencyKey(idempotencyKey);
        if (existing) {
          return this.resolveReplay(existing, payloadHash);
        }

        const transaction = await this.createTransaction(
          unitOfWork,
          command,
          payloadHash,
          idempotencyKey,
        );
        return { transaction, idempotentReplay: false };
      });
    } catch (error) {
      if (!(error instanceof IdempotencyKeyAlreadyClaimedError)) {
        throw error;
      }
      return this.repository.withTransaction(async (unitOfWork) => {
        const existing =
          await unitOfWork.findTransactionByIdempotencyKey(idempotencyKey);
        if (!existing) {
          throw error;
        }
        return this.resolveReplay(existing, payloadHash);
      });
    }
  }

  private resolveReplay(
    transaction: TransactionRecord,
    payloadHash: string,
  ): TransactionResult {
    if (transaction.payloadHash !== payloadHash) {
      throw new DomainError(
        FailureCode.IDEMPOTENCY_CONFLICT,
        'Idempotency-Key was already used with a different business payload',
      );
    }
    return { transaction, idempotentReplay: true };
  }

  async reprocessPending(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRecord | null> {
    return this.repository.withTransaction(async (unitOfWork) => {
      const existing = await unitOfWork.findTransaction(
        providerId,
        externalTransactionId,
      );
      if (
        !existing ||
        existing.status !== TransactionStatus.PENDING_REFERENCE
      ) {
        return existing;
      }
      return this.applyCommand(unitOfWork, existing, false);
    });
  }

  private async createTransaction(
    unitOfWork: FinancialUnitOfWork,
    command: TransactionCommand,
    payloadHash: string,
    idempotencyKey: string,
  ): Promise<TransactionRecord> {
    const now = new Date().toISOString();
    const transaction: TransactionRecord = {
      ...command,
      id: randomUUID(),
      status: TransactionStatus.NEW,
      payloadHash,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    return this.applyCommand(unitOfWork, transaction, true);
  }

  private async applyCommand(
    unitOfWork: FinancialUnitOfWork,
    transaction: TransactionRecord,
    isNew: boolean,
  ): Promise<TransactionRecord> {
    const command = transaction;
    if (isNew) {
      await unitOfWork.saveTransaction(transaction, true);
    }
    const wallet = await unitOfWork.findWallet(command.walletId);
    if (!wallet) {
      return this.reject(
        unitOfWork,
        transaction,
        FailureCode.WALLET_NOT_FOUND,
        false,
      );
    }
    if (wallet.currency !== command.currency) {
      return this.reject(
        unitOfWork,
        transaction,
        FailureCode.INVALID_CURRENCY,
        false,
      );
    }

    if (
      command.operation === TransactionOperation.REFUND ||
      command.operation === TransactionOperation.ROLLBACK ||
      (command.operation === TransactionOperation.WIN &&
        command.referenceExternalTransactionId)
    ) {
      const reference = await this.findReference(unitOfWork, transaction);
      if (reference === 'pending') {
        if (transaction.status === TransactionStatus.PENDING_REFERENCE) {
          return transaction;
        }
        return this.finish(
          unitOfWork,
          transaction,
          TransactionStatus.PENDING_REFERENCE,
          undefined,
          false,
        );
      }
      if (!reference) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.REFERENCE_NOT_FOUND,
          false,
        );
      }

      const mismatch =
        reference.providerId !== command.providerId ||
        reference.playerId !== command.playerId ||
        reference.walletId !== command.walletId ||
        reference.currency !== command.currency ||
        reference.roundId !== command.roundId;
      if (mismatch) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.REFERENCE_MISMATCH,
          false,
        );
      }

      if (
        command.operation === TransactionOperation.WIN &&
        reference.operation !== TransactionOperation.BET
      ) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.REFERENCE_NOT_REVERSIBLE,
          false,
        );
      }

      if (command.operation === TransactionOperation.REFUND) {
        if (reference.operation !== TransactionOperation.BET) {
          return this.reject(
            unitOfWork,
            transaction,
            FailureCode.REFERENCE_NOT_REVERSIBLE,
            false,
          );
        }
      } else if (
        command.operation === TransactionOperation.ROLLBACK &&
        ![TransactionOperation.BET, TransactionOperation.WIN].includes(
          reference.operation,
        )
      ) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.REFERENCE_NOT_REVERSIBLE,
          false,
        );
      }

      if (reference.status !== TransactionStatus.PROCESSED) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.REFERENCE_NOT_REVERSIBLE,
          false,
        );
      }

      if (
        command.operation === TransactionOperation.REFUND ||
        command.operation === TransactionOperation.ROLLBACK
      ) {
        const alreadyReversed = await unitOfWork.hasReversal(
          command.providerId,
          reference.externalTransactionId,
          command.operation,
          command.externalTransactionId,
        );
        if (alreadyReversed) {
          return this.reject(
            unitOfWork,
            transaction,
            FailureCode.DUPLICATE_REFERENCE_REVERSAL,
            false,
          );
        }
        if (toMinorUnits(reference.amount) !== toMinorUnits(command.amount)) {
          return this.reject(
            unitOfWork,
            transaction,
            FailureCode.REFERENCE_MISMATCH,
            false,
          );
        }
      }
    }

    let ledgerType: LedgerEntryType | undefined;
    let balanceDelta: bigint | undefined;

    switch (command.operation) {
      case TransactionOperation.BET:
        ledgerType = LedgerEntryType.DEBIT;
        balanceDelta = -toMinorUnits(command.amount);
        break;
      case TransactionOperation.WIN:
        ledgerType = LedgerEntryType.CREDIT;
        balanceDelta = toMinorUnits(command.amount);
        break;
      case TransactionOperation.REFUND:
        ledgerType = LedgerEntryType.CREDIT;
        balanceDelta = toMinorUnits(command.amount);
        break;
      case TransactionOperation.ROLLBACK: {
        const reference = await unitOfWork.findTransaction(
          command.providerId,
          command.referenceExternalTransactionId!,
        );
        if (!reference) {
          return this.finish(
            unitOfWork,
            transaction,
            TransactionStatus.PENDING_REFERENCE,
            undefined,
            false,
          );
        }
        ledgerType =
          reference.operation === TransactionOperation.BET
            ? LedgerEntryType.CREDIT
            : LedgerEntryType.DEBIT;
        balanceDelta =
          ledgerType === LedgerEntryType.CREDIT
            ? toMinorUnits(command.amount)
            : -toMinorUnits(command.amount);
        break;
      }
      case TransactionOperation.LOSS:
        break;
    }

    if (
      balanceDelta !== undefined &&
      balanceDelta < 0n &&
      toMinorUnits(wallet.balance) < -balanceDelta
    ) {
      return this.reject(
        unitOfWork,
        transaction,
        FailureCode.INSUFFICIENT_FUNDS,
        false,
      );
    }

    if (balanceDelta && ledgerType) {
      const balance = toMinorUnits(wallet.balance) + balanceDelta;
      if (balance < 0n) {
        throw new DomainError(
          FailureCode.INVALID_TRANSACTION_STATE,
          'Wallet balance cannot be negative',
        );
      }
      if (balance > 99999999999999999999n) {
        return this.reject(
          unitOfWork,
          transaction,
          FailureCode.BALANCE_LIMIT_EXCEEDED,
          false,
        );
      }
      const updatedWallet = {
        ...wallet,
        balance: fromMinorUnits(balance),
      };
      await unitOfWork.saveWallet(updatedWallet);
      const entry: LedgerEntry = {
        id: randomUUID(),
        transactionId: transaction.id,
        walletId: transaction.walletId,
        type: ledgerType,
        amount: command.amount,
        currency: command.currency,
        createdAt: new Date().toISOString(),
      };
      await unitOfWork.appendLedgerEntry(entry);
    }

    return this.finish(
      unitOfWork,
      transaction,
      TransactionStatus.PROCESSED,
      undefined,
      false,
    );
  }

  private async findReference(
    unitOfWork: FinancialUnitOfWork,
    transaction: TransactionRecord,
  ): Promise<TransactionRecord | 'pending' | null> {
    if (!transaction.referenceExternalTransactionId) {
      return null;
    }
    const reference = await unitOfWork.findTransaction(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    if (!reference) {
      return 'pending';
    }
    if (reference.status === TransactionStatus.PENDING_REFERENCE) {
      return 'pending';
    }
    return reference;
  }

  private async reject(
    unitOfWork: FinancialUnitOfWork,
    transaction: TransactionRecord,
    failureCode: FailureCode,
    isNew: boolean,
  ): Promise<TransactionRecord> {
    return this.finish(
      unitOfWork,
      transaction,
      TransactionStatus.REJECTED,
      failureCode,
      isNew,
    );
  }

  private async finish(
    unitOfWork: FinancialUnitOfWork,
    transaction: TransactionRecord,
    status: TransactionStatus,
    failureCode: FailureCode | undefined,
    isNew: boolean,
  ): Promise<TransactionRecord> {
    const updated = transitionTransaction(transaction, status, failureCode);
    await unitOfWork.saveTransaction(updated, isNew);
    return updated;
  }
}
