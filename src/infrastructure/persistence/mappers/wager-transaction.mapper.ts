import { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.js';
import { DomainError } from '../../../domain/domain-error.js';
import { FailureCode } from '../../../domain/failure-code.js';
import { Money } from '../../../domain/value-objects/money.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

function parseKind(value: string): WagerTransactionKind {
  if (
    !Object.values(WagerTransactionKind).includes(value as WagerTransactionKind)
  ) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      `Persisted transaction kind is invalid: ${value}`,
    );
  }
  return value as WagerTransactionKind;
}

function parseStatus(value: string): WagerTransactionStatus {
  if (
    !Object.values(WagerTransactionStatus).includes(
      value as WagerTransactionStatus,
    )
  ) {
    throw new DomainError(
      FailureCode.INVALID_TRANSACTION_STATE,
      `Persisted transaction status is invalid: ${value}`,
    );
  }
  return value as WagerTransactionStatus;
}

function parseFailureCode(
  value: string | null | undefined,
): FailureCode | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Object.values(FailureCode).includes(value as FailureCode)) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      `Persisted transaction failure code is invalid: ${value}`,
    );
  }
  return value as FailureCode;
}

export class WagerTransactionMapper {
  static toPersistence(transaction: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.moneyAmount = transaction.money.toJSON().amount;
    entity.moneyCurrency = transaction.money.currency;
    entity.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId ?? null;
    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.failureCode = transaction.failureCode ?? null;
    entity.processedAt = transaction.processedAt ?? null;
    entity.resultingBalanceAmount =
      transaction.resultingBalance?.toJSON().amount ?? null;
    entity.createdAt = transaction.createdAt;
    entity.updatedAt = transaction.updatedAt;
    return entity;
  }

  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      playerId: entity.playerId,
      walletId: entity.walletId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      kind: parseKind(entity.kind),
      money: Money.from({
        amount: entity.moneyAmount,
        currency: entity.moneyCurrency,
      }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      status: parseStatus(entity.status),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      processedAt: entity.processedAt ?? undefined,
      failureCode: parseFailureCode(entity.failureCode),
      resultingBalance:
        entity.resultingBalanceAmount !== null &&
        entity.resultingBalanceAmount !== undefined
          ? Money.from({
              amount: entity.resultingBalanceAmount,
              currency: entity.moneyCurrency,
            })
          : undefined,
    });
  }
}
