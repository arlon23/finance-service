import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../../src/domain/aggregates/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/domain/entities/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/entities/wager-transaction.js';
import { FailureCode } from '../../../src/domain/failure-code.js';
import { Money } from '../../../src/domain/value-objects/money.js';
import { WalletLedgerEntryMapper } from '../../../src/infrastructure/persistence/mappers/wallet-ledger-entry.mapper.js';
import { WalletMapper } from '../../../src/infrastructure/persistence/mappers/wallet.mapper.js';
import { WagerTransactionMapper } from '../../../src/infrastructure/persistence/mappers/wager-transaction.mapper.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');
const updatedAt = new Date('2026-01-02T03:06:07.000Z');

describe('WalletMapper', () => {
  it('preserves wallet state and exact decimal strings in both directions', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-id',
      playerId: 'player-id',
      currency: 'USD',
      _balance: Money.from({ amount: '1234567890123456.78', currency: 'USD' }),
      _version: 7,
      createdAt,
      _updatedAt: updatedAt,
    });

    const persisted = WalletMapper.toPersistence(wallet);
    const restored = WalletMapper.toDomain(persisted);

    expect(persisted.balance).toBe('1234567890123456.78');
    expect(restored).toMatchObject({
      id: 'wallet-id',
      playerId: 'player-id',
      currency: 'USD',
      version: 7,
      createdAt,
      updatedAt,
    });
    expect(restored.balance).toBeInstanceOf(Money);
    expect(restored.balance.toJSON()).toEqual({
      amount: '1234567890123456.78',
      currency: 'USD',
    });
    expect(restored.createdAt).not.toBe(createdAt);
    expect(restored.updatedAt).not.toBe(updatedAt);
  });
});

describe('WagerTransactionMapper', () => {
  it('preserves transaction metadata, references, status and exact amount', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'transaction-id',
      providerId: 'provider',
      externalTransactionId: 'external-id',
      playerId: 'player-id',
      walletId: 'wallet-id',
      roundId: 'round-id',
      gameId: 'game-id',
      idempotencyKey: 'provider:external-id',
      payloadHash: 'a'.repeat(64),
      kind: WagerTransactionKind.REFUND,
      money: Money.from({ amount: '0.10', currency: 'EUR' }),
      referenceExternalTransactionId: 'original-bet',
      referenceTransactionId: 'reference-id',
      status: WagerTransactionStatus.PROCESSED,
      createdAt,
      updatedAt,
      processedAt: updatedAt,
    });

    const persisted = WagerTransactionMapper.toPersistence(transaction);
    const restored = WagerTransactionMapper.toDomain(persisted);

    expect(persisted.moneyAmount).toBe('0.10');
    expect(restored).toMatchObject({
      id: 'transaction-id',
      providerId: 'provider',
      externalTransactionId: 'external-id',
      playerId: 'player-id',
      walletId: 'wallet-id',
      roundId: 'round-id',
      gameId: 'game-id',
      idempotencyKey: 'provider:external-id',
      payloadHash: 'a'.repeat(64),
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'original-bet',
      referenceTransactionId: 'reference-id',
      status: WagerTransactionStatus.PROCESSED,
      createdAt,
      updatedAt,
      processedAt: updatedAt,
    });
    expect(restored.money.toJSON()).toEqual({
      amount: '0.10',
      currency: 'EUR',
    });
    expect(restored.failureCode).toBeUndefined();
  });

  it('preserves rejected transaction failure codes', () => {
    const rejected = WagerTransaction.rehydrate({
      id: 'transaction-id',
      providerId: 'provider',
      externalTransactionId: 'external-id',
      playerId: 'player-id',
      walletId: 'wallet-id',
      roundId: 'round-id',
      gameId: 'game-id',
      idempotencyKey: 'provider:external-id',
      payloadHash: 'b'.repeat(64),
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: '1.25', currency: 'USD' }),
      status: WagerTransactionStatus.REJECTED,
      createdAt,
      updatedAt,
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });

    const restored = WagerTransactionMapper.toDomain(
      WagerTransactionMapper.toPersistence(rejected),
    );

    expect(restored.status).toBe(WagerTransactionStatus.REJECTED);
    expect(restored.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(restored.processedAt).toBeUndefined();
  });
});

describe('WalletLedgerEntryMapper', () => {
  it('preserves immutable ledger values and exact balances in both directions', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id',
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '0.10', currency: 'USD' }),
      balanceBefore: Money.from({ amount: '1.00', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '0.90', currency: 'USD' }),
      createdAt,
    });

    const persisted = WalletLedgerEntryMapper.toPersistence(entry);
    const restored = WalletLedgerEntryMapper.toDomain(persisted);

    expect(persisted.moneyAmount).toBe('0.10');
    expect(persisted.balanceBeforeAmount).toBe('1.00');
    expect(persisted.balanceAfterAmount).toBe('0.90');
    expect(restored).toMatchObject({
      id: 'ledger-id',
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      direction: LedgerDirection.DEBIT,
      createdAt,
    });
    expect(restored.money.toJSON()).toEqual({
      amount: '0.10',
      currency: 'USD',
    });
    expect(restored.balanceBefore.toJSON()).toEqual({
      amount: '1.00',
      currency: 'USD',
    });
    expect(restored.balanceAfter.toJSON()).toEqual({
      amount: '0.90',
      currency: 'USD',
    });
    expect(Object.isFrozen(restored)).toBe(true);
  });
});
