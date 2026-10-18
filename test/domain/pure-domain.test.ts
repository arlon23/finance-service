import { describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { Wallet } from '../../src/domain/aggregates/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';
import { DomainError } from '../../src/domain/domain-error.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import { Money } from '../../src/domain/value-objects/money.js';

describe('Money', () => {
  it('parses exact amounts and serializes a fixed two-digit scale', () => {
    const money = Money.from({ amount: '123.4', currency: 'USD' });

    expect(money.value).toBeInstanceOf(Decimal);
    expect(money.toJSON()).toEqual({ amount: '123.40', currency: 'USD' });
    expect(money.toString()).toBe('123.40 USD');
  });

  it('rejects invalid, scientific, negative, and over-precision amounts', () => {
    for (const amount of ['', 'NaN', 'Infinity', '1e2', '-1', '1.001']) {
      expect(() => Money.from({ amount, currency: 'USD' })).toThrow(
        DomainError,
      );
    }
  });

  it('rejects invalid currency codes', () => {
    for (const currency of ['usd', 'US', 'USDD', '123']) {
      expect(() => Money.from({ amount: '1', currency })).toThrow(
        expect.objectContaining({ failureCode: FailureCode.INVALID_CURRENCY }),
      );
    }
  });

  it('supports exact immutable arithmetic and comparisons', () => {
    const one = Money.from({ amount: '0.10', currency: 'USD' });
    const two = Money.from({ amount: '0.20', currency: 'USD' });
    const sum = one.add(two);
    const difference = one.subtract(two);
    const negative = one.negate();

    expect(sum).not.toBe(one);
    expect(sum).not.toBe(two);
    expect(difference).not.toBe(one);
    expect(negative).not.toBe(one);
    expect(sum.toJSON().amount).toBe('0.30');
    expect(difference.toJSON().amount).toBe('-0.10');
    expect(negative.isNegative()).toBe(true);
    expect(one.isPositive()).toBe(true);
    expect(Money.from({ amount: '0', currency: 'USD' }).isZero()).toBe(true);
    expect(Money.zero('USD').isPositive()).toBe(false);
    expect(Money.zero('USD').isZero()).toBe(true);
    expect(one.isLessThan(two)).toBe(true);
    expect(one.equals(Money.from({ amount: '0.1', currency: 'USD' }))).toBe(
      true,
    );
    expect(one.toJSON().amount).toBe('0.10');
    expect(two.toJSON().amount).toBe('0.20');
  });

  it('rejects arithmetic and comparison across currencies', () => {
    const usd = Money.from({ amount: '1', currency: 'USD' });
    const eur = Money.from({ amount: '1', currency: 'EUR' });

    expect(() => usd.add(eur)).toThrow(
      expect.objectContaining({ failureCode: FailureCode.INVALID_CURRENCY }),
    );
    expect(() => usd.subtract(eur)).toThrow(DomainError);
    expect(() => usd.isLessThan(eur)).toThrow(DomainError);
    expect(usd.equals(eur)).toBe(false);
  });

  it('does not expose its internal Decimal instance for mutation', () => {
    const money = Money.from({ amount: '12.34', currency: 'USD' });
    const exposedDecimal = money.value;
    exposedDecimal.d[0] = 999;
    expect(money.toJSON().amount).toBe('12.34');
  });
});

describe('Wallet', () => {
  it('opens with version one and increments the version for each movement', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
    });
    const originalUpdatedAt = wallet.updatedAt;

    expect(wallet.version).toBe(1);
    wallet.debit(Money.from({ amount: '2.25', currency: 'USD' }));
    expect(wallet.balance.toJSON().amount).toBe('7.75');
    expect(wallet.version).toBe(2);
    wallet.credit(Money.from({ amount: '1.10', currency: 'USD' }));
    expect(wallet.balance.toJSON().amount).toBe('8.85');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('rejects overdrafts, negative movements, and currency mismatches', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('USD'),
    });
    const negative = Money.zero('USD').subtract(
      Money.from({ amount: '1', currency: 'USD' }),
    );

    expect(() =>
      wallet.debit(Money.from({ amount: '0.01', currency: 'USD' })),
    ).toThrow(
      expect.objectContaining({
        failureCode: FailureCode.NEGATIVE_BALANCE_PREVENTED,
      }),
    );
    expect(() => wallet.credit(negative)).toThrow(DomainError);
    expect(() => wallet.debit(Money.zero('EUR'))).toThrow(DomainError);
    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(1);
  });

  it('refuses to open a wallet with a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-negative',
        playerId: 'player-1',
        initialBalance: Money.zero('USD').subtract(
          Money.from({ amount: '0.01', currency: 'USD' }),
        ),
      }),
    ).toThrow(
      expect.objectContaining({
        failureCode: FailureCode.INVALID_WALLET_BALANCE,
      }),
    );
  });

  it('rehydrates persisted state without altering its version or balance', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-02T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'wallet-2',
      playerId: 'player-2',
      currency: 'USD',
      _balance: Money.from({ amount: '3.25', currency: 'USD' }),
      _version: 8,
      createdAt,
      _updatedAt: updatedAt,
    });
    createdAt.setFullYear(2030);
    wallet.updatedAt.setFullYear(2040);

    expect(wallet.version).toBe(8);
    expect(wallet.balance.toJSON().amount).toBe('3.25');
    expect(wallet.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('WagerTransaction', () => {
  const props = {
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    idempotencyKey: 'provider-1:external-1',
    payloadHash: 'payload-hash',
    kind: WagerTransactionKind.BET,
    money: Money.from({ amount: '5', currency: 'USD' }),
  };

  it('creates as pending and reports domain queries', () => {
    const bet = WagerTransaction.create(props);
    const loss = WagerTransaction.create({
      ...props,
      id: 'transaction-loss',
      externalTransactionId: 'external-loss',
      kind: WagerTransactionKind.LOSS,
    });

    expect(bet.status).toBe(WagerTransactionStatus.PENDING);
    expect(bet.isTerminal()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.matchesPayload('payload-hash')).toBe(true);
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.isTerminal()).toBe(false);
    expect(
      WagerTransaction.create({
        ...props,
        id: 'transaction-opening',
        externalTransactionId: 'external-opening',
        kind: WagerTransactionKind.OPENING,
      }).affectsBalance(),
    ).toBe(true);
  });

  it('requires references for refunds and rollbacks', () => {
    for (const kind of [
      WagerTransactionKind.REFUND,
      WagerTransactionKind.ROLLBACK,
    ]) {
      expect(() => WagerTransaction.create({ ...props, kind })).toThrow(
        DomainError,
      );
      expect(
        WagerTransaction.create({
          ...props,
          kind,
          referenceExternalTransactionId: 'original-1',
        }).requiresReference(),
      ).toBe(true);
    }
    expect(() =>
      WagerTransaction.create({
        ...props,
        referenceExternalTransactionId: props.externalTransactionId,
      }),
    ).toThrow(DomainError);
    expect(() =>
      WagerTransaction.create({
        ...props,
        money: Money.zero('USD').subtract(
          Money.from({ amount: '1', currency: 'USD' }),
        ),
      }),
    ).toThrow(DomainError);
  });

  it('requires an idempotency key and payload hash and compares payloads exactly', () => {
    const transaction = WagerTransaction.create(props);
    expect(transaction.matchesPayload('payload-hash')).toBe(true);
    expect(transaction.matchesPayload('different-payload-hash')).toBe(false);

    expect(() =>
      WagerTransaction.create({ ...props, idempotencyKey: '' }),
    ).toThrow(
      expect.objectContaining({ failureCode: FailureCode.INVALID_PAYLOAD }),
    );
    expect(() =>
      WagerTransaction.create({ ...props, payloadHash: ' ' }),
    ).toThrow(
      expect.objectContaining({ failureCode: FailureCode.INVALID_PAYLOAD }),
    );
  });

  it('allows pending-reference processing and prevents repeated terminal transitions', () => {
    const processed = WagerTransaction.create({
      ...props,
      id: 'transaction-processed',
      externalTransactionId: 'external-processed',
    });
    processed.markProcessed();
    expect(processed.status).toBe(WagerTransactionStatus.PROCESSED);

    const pending = WagerTransaction.create(props);
    pending.markPendingReference();
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(() => pending.markPendingReference()).toThrow(DomainError);
    pending.markProcessed();
    expect(pending.isTerminal()).toBe(true);
    expect(() => pending.reject()).toThrow(
      expect.objectContaining({
        failureCode: FailureCode.INVALID_TRANSACTION_STATE,
      }),
    );

    const rejected = WagerTransaction.create({
      ...props,
      id: 'transaction-2',
      externalTransactionId: 'external-2',
    });
    rejected.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(() => rejected.markProcessed()).toThrow(DomainError);

    const failed = WagerTransaction.create({
      ...props,
      id: 'transaction-3',
      externalTransactionId: 'external-3',
    });
    failed.fail(FailureCode.INVALID_PAYLOAD);
    expect(failed.status).toBe(WagerTransactionStatus.FAILED);
    expect(failed.isTerminal()).toBe(true);
    expect(() => failed.fail()).toThrow(DomainError);
  });

  it('rejects every transition from each terminal status', () => {
    const terminalTransactions = [
      {
        id: 'processed',
        status: WagerTransactionStatus.PROCESSED,
        transition: (transaction: WagerTransaction) =>
          transaction.markProcessed(),
      },
      {
        id: 'rejected',
        status: WagerTransactionStatus.REJECTED,
        transition: (transaction: WagerTransaction) => transaction.reject(),
      },
      {
        id: 'failed',
        status: WagerTransactionStatus.FAILED,
        transition: (transaction: WagerTransaction) => transaction.fail(),
      },
    ] as const;

    for (const terminal of terminalTransactions) {
      const transaction = WagerTransaction.rehydrate({
        ...props,
        id: `transaction-${terminal.id}`,
        externalTransactionId: `external-${terminal.id}`,
        status: terminal.status,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed()).toThrow(
        expect.objectContaining({
          failureCode: FailureCode.INVALID_TRANSACTION_STATE,
        }),
      );
      expect(() => transaction.markPendingReference()).toThrow(DomainError);
      expect(() => transaction.reject()).toThrow(DomainError);
      expect(() => transaction.fail()).toThrow(DomainError);
      expect(transaction.status).toBe(terminal.status);

      const created = WagerTransaction.create({
        ...props,
        id: `transition-${terminal.id}`,
        externalTransactionId: `transition-external-${terminal.id}`,
      });
      terminal.transition(created);
      expect(created.status).toBe(terminal.status);
      expect(created.isTerminal()).toBe(true);
    }
  });

  it('rehydrates persisted terminal state directly', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const transaction = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.FAILED,
      createdAt: now,
      updatedAt: now,
      failureCode: FailureCode.INVALID_PAYLOAD,
    });
    now.setFullYear(2030);

    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.createdAt.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(transaction.failureCode).toBe(FailureCode.INVALID_PAYLOAD);
  });
});

describe('WalletLedgerEntry', () => {
  it('validates debit and credit balances exactly', () => {
    const money = Money.from({ amount: '2.35', currency: 'USD' });
    const debit = WalletLedgerEntry.create({
      id: 'entry-debit',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.DEBIT,
      money,
      balanceBefore: Money.from({ amount: '10', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '7.65', currency: 'USD' }),
    });
    const credit = WalletLedgerEntry.create({
      id: 'entry-credit',
      walletId: 'wallet-1',
      transactionId: 'transaction-2',
      direction: LedgerDirection.CREDIT,
      money,
      balanceBefore: Money.from({ amount: '7.65', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '10', currency: 'USD' }),
    });

    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
  });

  it('rejects inconsistent balances, negative results, and currency conflicts', () => {
    const money = Money.from({ amount: '2.35', currency: 'USD' });
    const base = {
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.DEBIT,
      money,
      balanceBefore: Money.from({ amount: '10', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '8', currency: 'USD' }),
    };

    expect(() => WalletLedgerEntry.create(base)).toThrow(
      expect.objectContaining({
        failureCode: FailureCode.INVALID_LEDGER_ENTRY,
      }),
    );
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: Money.from({ amount: '1', currency: 'USD' }),
        balanceAfter: Money.zero('USD').subtract(
          Money.from({ amount: '1.35', currency: 'USD' }),
        ),
      }),
    ).toThrow(DomainError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceAfter: Money.from({ amount: '7.65', currency: 'EUR' }),
      }),
    ).toThrow(DomainError);
  });

  it('is structurally immutable and does not expose its internal timestamp', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const entry = WalletLedgerEntry.create({
      id: 'entry-immutable',
      walletId: 'wallet-1',
      transactionId: 'transaction-immutable',
      direction: LedgerDirection.CREDIT,
      money: Money.from({ amount: '1.25', currency: 'USD' }),
      balanceBefore: Money.from({ amount: '0', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '1.25', currency: 'USD' }),
      createdAt,
    });
    createdAt.setFullYear(2030);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    entry.createdAt.setFullYear(2040);
    expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
