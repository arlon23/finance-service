import {
  LedgerDirection,
  WalletLedgerEntry,
  type WalletLedgerEntryState,
} from '../../../domain/entities/wallet-ledger-entry.js';
import { DomainError } from '../../../domain/domain-error.js';
import { FailureCode } from '../../../domain/failure-code.js';
import { Money } from '../../../domain/value-objects/money.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

function parseDirection(value: string): LedgerDirection {
  if (!Object.values(LedgerDirection).includes(value as LedgerDirection)) {
    throw new DomainError(
      FailureCode.INVALID_LEDGER_ENTRY,
      `Persisted ledger direction is invalid: ${value}`,
    );
  }
  return value as LedgerDirection;
}

export class WalletLedgerEntryMapper {
  static toPersistence(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.moneyAmount = entry.money.toJSON().amount;
    entity.moneyCurrency = entry.money.currency;
    entity.balanceBeforeAmount = entry.balanceBefore.toJSON().amount;
    entity.balanceBeforeCurrency = entry.balanceBefore.currency;
    entity.balanceAfterAmount = entry.balanceAfter.toJSON().amount;
    entity.balanceAfterCurrency = entry.balanceAfter.currency;
    entity.createdAt = entry.createdAt;
    return entity;
  }

  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const state: WalletLedgerEntryState = {
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: parseDirection(entity.direction),
      money: Money.from({
        amount: entity.moneyAmount,
        currency: entity.moneyCurrency,
      }),
      balanceBefore: Money.from({
        amount: entity.balanceBeforeAmount,
        currency: entity.balanceBeforeCurrency,
      }),
      balanceAfter: Money.from({
        amount: entity.balanceAfterAmount,
        currency: entity.balanceAfterCurrency,
      }),
      createdAt: entity.createdAt,
    };
    return WalletLedgerEntry.rehydrate(state);
  }
}
