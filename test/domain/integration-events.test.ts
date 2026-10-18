import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import { WagerTransactionPendingReference } from '../../src/domain/events/wager-transaction-pending-reference.event.js';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed.event.js';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-rejected.event.js';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed.event.js';
import { Money } from '../../src/domain/value-objects/money.js';

const metadata = {
  eventId: 'event-1',
  aggregateId: 'wallet-1',
  correlationId: 'correlation-1',
  causationId: 'cause-1',
  occurredAt: new Date('2026-10-17T12:00:00.000Z'),
};

describe('Integration events', () => {
  it('serializes a processed transaction in the standard JSON envelope', () => {
    const event = new WagerTransactionProcessed(metadata, {
      transactionId: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.WIN,
      money: { amount: '123456789012345.67', currency: 'USD' },
      resultingBalance: { amount: '123456789112345.67', currency: 'USD' },
      referenceExternalTransactionId: 'bet-1',
    });

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      occurredAt: '2026-10-17T12:00:00.000Z',
      version: 1,
      eventType: 'WagerTransactionProcessed',
      data: {
        transactionId: 'transaction-1',
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '123456789012345.67', currency: 'USD' },
        resultingBalance: {
          amount: '123456789112345.67',
          currency: 'USD',
        },
        referenceExternalTransactionId: 'bet-1',
      },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it('serializes rejected and pending-reference transaction details', () => {
    const rejected = new WagerTransactionRejected(metadata, {
      transactionId: 'transaction-2',
      providerId: 'provider-1',
      externalTransactionId: 'external-2',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      kind: WagerTransactionKind.BET,
      money: { amount: '10.00', currency: 'USD' },
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    const pending = new WagerTransactionPendingReference(metadata, {
      transactionId: 'transaction-3',
      providerId: 'provider-1',
      externalTransactionId: 'external-3',
      referenceExternalTransactionId: 'bet-later',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      kind: WagerTransactionKind.REFUND,
      money: { amount: '10.00', currency: 'USD' },
    });

    expect(rejected.toJSON().eventType).toBe('WagerTransactionRejected');
    expect(rejected.toJSON().data.failureCode).toBe(
      FailureCode.INSUFFICIENT_FUNDS,
    );
    expect(pending.toJSON().eventType).toBe('WagerTransactionPendingReference');
    expect(pending.toJSON().data.money).toEqual({
      amount: '10.00',
      currency: 'USD',
    });
  });

  it('serializes balance changes with immutable decimal-string money values', () => {
    const event = new WalletBalanceChanged(metadata, {
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.DEBIT,
      money: { amount: '0.10', currency: 'USD' },
      balanceBefore: { amount: '100.00', currency: 'USD' },
      balanceAfter: { amount: '99.90', currency: 'USD' },
      walletVersion: 7,
    });

    expect(event.toJSON().data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: 'DEBIT',
      money: { amount: '0.10', currency: 'USD' },
      balanceBefore: { amount: '100.00', currency: 'USD' },
      balanceAfter: { amount: '99.90', currency: 'USD' },
      walletVersion: 7,
    });
  });

  it('isolates event data and occurrence time from mutable inputs', () => {
    const money = { amount: '1.00', currency: 'USD' };
    const data = {
      transactionId: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.BET,
      money,
      resultingBalance: { amount: '9.00', currency: 'USD' },
    };
    const occurredAt = new Date(metadata.occurredAt);
    const event = new WagerTransactionProcessed(
      { ...metadata, occurredAt },
      data,
    );

    money.amount = '999.00';
    data.transactionId = 'mutated';
    occurredAt.setFullYear(2000);
    const json = event.toJSON();

    expect(event.data.transactionId).toBe('transaction-1');
    expect(event.data.money.amount).toBe('1.00');
    expect(event.occurredAt.toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(event.toJSON().data.money.amount).toBe('1.00');
    expect(json.data).not.toBe(event.data);
  });

  it('rejects domain objects and invalid JSON data', () => {
    const domainObjectData = {
      transactionId: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      resultingBalance: { amount: '9.00', currency: 'USD' },
    };
    expect(
      () =>
        new WagerTransactionProcessed(
          metadata,
          domainObjectData as unknown as ConstructorParameters<
            typeof WagerTransactionProcessed
          >[1],
        ),
    ).toThrow('plain JSON-compatible objects');

    const badData = {
      transactionId: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.BET,
      money: { amount: '1.00', currency: 'USD' },
      resultingBalance: { amount: '9.00', currency: 'USD' },
      invalid: Number.NaN,
    };
    expect(() => new WagerTransactionProcessed(metadata, badData)).toThrow(
      'Integration event data must contain finite numbers',
    );
  });
});
