import { describe, expect, it } from 'bun:test';
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
import { FailureCode } from '../../src/domain/failure-code.js';
import { Money } from '../../src/domain/value-objects/money.js';

const common = {
  providerId: 'provider-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
};

function createWallet(amount = '100.00', currency = 'USD'): Wallet {
  return Wallet.open({
    id: common.walletId,
    playerId: common.playerId,
    initialBalance: Money.from({ amount, currency }),
  });
}

function createTransaction(
  kind: WagerTransactionKind,
  externalTransactionId: string,
  options: {
    amount?: string;
    currency?: string;
    referenceExternalTransactionId?: string;
    playerId?: string;
    walletId?: string;
    roundId?: string;
    providerId?: string;
  } = {},
): WagerTransaction {
  const providerId = options.providerId ?? common.providerId;
  return WagerTransaction.create({
    id: `id-${externalTransactionId}`,
    ...common,
    providerId,
    playerId: options.playerId ?? common.playerId,
    walletId: options.walletId ?? common.walletId,
    roundId: options.roundId ?? common.roundId,
    externalTransactionId,
    gameId: common.gameId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    kind,
    money: Money.from({
      amount: options.amount ?? '10.00',
      currency: options.currency ?? 'USD',
    }),
    ...(options.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            options.referenceExternalTransactionId,
        }
      : {}),
  });
}

function process(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: {
    reference?: WagerTransaction | null;
    alreadyReversed?: boolean;
  } = {},
): WalletLedgerEntry | null {
  return transaction.process(wallet, {
    ledgerEntryId: `ledger-${transaction.id}`,
    ...options,
  });
}

function processBet(wallet: Wallet, externalTransactionId = 'bet-1') {
  const bet = createTransaction(
    WagerTransactionKind.BET,
    externalTransactionId,
  );
  const entry = process(bet, wallet);
  expect(entry).toBeInstanceOf(WalletLedgerEntry);
  return { bet, entry: entry! };
}

describe('WagerTransaction domain processing', () => {
  it('debits the wallet and returns a consistent debit ledger entry for BET', () => {
    const wallet = createWallet();
    const { bet, entry } = processBet(wallet);

    expect(wallet.balance.toJSON()).toEqual({
      amount: '90.00',
      currency: 'USD',
    });
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.DEBIT);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('90.00');
    expect(entry.isBalanced()).toBe(true);
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
  });

  it('rejects an unaffordable BET without changing wallet balance or version', () => {
    const wallet = createWallet('5.00');
    const bet = createTransaction(WagerTransactionKind.BET, 'bet-too-large');

    expect(process(bet, wallet)).toBeNull();
    expect(wallet.balance.toJSON().amount).toBe('5.00');
    expect(wallet.version).toBe(1);
    expect(bet.status).toBe(WagerTransactionStatus.REJECTED);
    expect(bet.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
  });

  it('credits WIN, supports a same-round BET reference, and records LOSS without a ledger', () => {
    const wallet = createWallet();
    const { bet } = processBet(wallet);
    const win = createTransaction(WagerTransactionKind.WIN, 'win-1', {
      amount: '4.25',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const winEntry = process(win, wallet, { reference: bet });

    expect(winEntry?.direction).toBe(LedgerDirection.CREDIT);
    expect(winEntry?.balanceAfter.toJSON().amount).toBe('94.25');
    expect(wallet.balance.toJSON().amount).toBe('94.25');
    expect(win.status).toBe(WagerTransactionStatus.PROCESSED);

    const loss = createTransaction(WagerTransactionKind.LOSS, 'loss-1');
    const previousVersion = wallet.version;
    expect(loss.affectsBalance()).toBe(false);
    expect(process(loss, wallet)).toBeNull();
    expect(loss.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(wallet.balance.toJSON().amount).toBe('94.25');
    expect(wallet.version).toBe(previousVersion);
  });

  it('leaves a dependent operation pending until its reference is available', () => {
    const wallet = createWallet();
    const refund = createTransaction(WagerTransactionKind.REFUND, 'refund-1', {
      referenceExternalTransactionId: 'bet-late',
    });

    expect(process(refund, wallet)).toBeNull();
    expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(wallet.balance.toJSON().amount).toBe('100.00');

    const pendingBet = createTransaction(WagerTransactionKind.BET, 'bet-late');
    expect(process(refund, wallet, { reference: pendingBet })).toBeNull();
    expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    process(pendingBet, wallet);
    const refundEntry = process(refund, wallet, { reference: pendingBet });
    expect(refundEntry?.direction).toBe(LedgerDirection.CREDIT);
    expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(refund.referenceTransactionId).toBe(pendingBet.id);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  it('rejects refunds for invalid references and differing amounts', () => {
    const wallet = createWallet();
    const { bet } = processBet(wallet);
    const invalidReference = createTransaction(
      WagerTransactionKind.WIN,
      'win-reference',
    );
    process(invalidReference, wallet);

    const refundOfWin = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-win',
      {
        referenceExternalTransactionId: invalidReference.externalTransactionId,
      },
    );
    expect(
      process(refundOfWin, wallet, { reference: invalidReference }),
    ).toBeNull();
    expect(refundOfWin.failureCode).toBe(FailureCode.REFERENCE_NOT_REVERSIBLE);

    const wrongAmount = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-amount',
      {
        amount: '9.99',
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    );
    expect(process(wrongAmount, wallet, { reference: bet })).toBeNull();
    expect(wrongAmount.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  it('rejects reference identity, currency, and round mismatches', () => {
    const wallet = createWallet();
    const { bet } = processBet(wallet);
    const wrongIdentity = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-identity',
      {
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: 'round-2',
      },
    );

    expect(process(wrongIdentity, wallet, { reference: bet })).toBeNull();
    expect(wrongIdentity.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);

    const euroBet = createTransaction(WagerTransactionKind.BET, 'bet-eur', {
      currency: 'EUR',
    });
    process(
      euroBet,
      Wallet.rehydrate({
        id: common.walletId,
        playerId: common.playerId,
        currency: 'EUR',
        _balance: Money.from({ amount: '100.00', currency: 'EUR' }),
        _version: 1,
        createdAt: new Date(),
        _updatedAt: new Date(),
      }),
    );
    const wrongCurrency = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-currency',
      { referenceExternalTransactionId: euroBet.externalTransactionId },
    );
    expect(process(wrongCurrency, wallet, { reference: euroBet })).toBeNull();
    expect(wrongCurrency.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);

    for (const [index, mismatch] of [
      { providerId: 'other-provider' },
      { playerId: 'other-player' },
      { walletId: 'other-wallet' },
      { roundId: 'other-round' },
      { currency: 'EUR' },
    ].entries()) {
      const mismatchedReference = createTransaction(
        WagerTransactionKind.BET,
        `bet-mismatch-${index}`,
        mismatch,
      );
      mismatchedReference.markProcessed();
      const dependent = createTransaction(
        WagerTransactionKind.ROLLBACK,
        `rollback-mismatch-${index}`,
        {
          referenceExternalTransactionId:
            mismatchedReference.externalTransactionId,
        },
      );
      expect(
        process(dependent, wallet, { reference: mismatchedReference }),
      ).toBeNull();
      expect(dependent.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
    }
  });

  it('reverses BET, WIN and REFUND effects through ROLLBACK', () => {
    const wallet = createWallet();
    const { bet } = processBet(wallet);
    const rollbackBet = createTransaction(
      WagerTransactionKind.ROLLBACK,
      'rollback-bet',
      { referenceExternalTransactionId: bet.externalTransactionId },
    );
    const betRollbackEntry = process(rollbackBet, wallet, { reference: bet });
    expect(betRollbackEntry?.direction).toBe(LedgerDirection.CREDIT);
    expect(wallet.balance.toJSON().amount).toBe('100.00');

    const win = createTransaction(WagerTransactionKind.WIN, 'win-rollback');
    process(win, wallet);
    const rollbackWin = createTransaction(
      WagerTransactionKind.ROLLBACK,
      'rollback-win',
      { referenceExternalTransactionId: win.externalTransactionId },
    );
    const winRollbackEntry = process(rollbackWin, wallet, { reference: win });
    expect(winRollbackEntry?.direction).toBe(LedgerDirection.DEBIT);
    expect(wallet.balance.toJSON().amount).toBe('100.00');

    const refund = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-rollback',
      {
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    );
    process(refund, wallet, { reference: bet });
    const rollbackRefund = createTransaction(
      WagerTransactionKind.ROLLBACK,
      'rollback-refund',
      { referenceExternalTransactionId: refund.externalTransactionId },
    );
    const refundRollbackEntry = process(rollbackRefund, wallet, {
      reference: refund,
    });
    expect(refundRollbackEntry?.direction).toBe(LedgerDirection.DEBIT);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  it('rejects duplicate reversals and prevents rollback from making balance negative', () => {
    const wallet = createWallet();
    const { bet } = processBet(wallet);
    const refund = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-once',
      {
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    );
    process(refund, wallet, { reference: bet });
    const duplicateRefund = createTransaction(
      WagerTransactionKind.REFUND,
      'refund-twice',
      { referenceExternalTransactionId: bet.externalTransactionId },
    );
    expect(
      process(duplicateRefund, wallet, {
        reference: bet,
        existingReversals: [refund],
      }),
    ).toBeNull();
    expect(duplicateRefund.failureCode).toBe(FailureCode.DUPLICATE_REFERENCE);

    const rollback = createTransaction(
      WagerTransactionKind.ROLLBACK,
      'rollback-refund',
      {
        referenceExternalTransactionId: refund.externalTransactionId,
      },
    );
    wallet.debit(Money.from({ amount: '95.00', currency: 'USD' }));
    const balance = wallet.balance.toJSON().amount;
    const version = wallet.version;
    expect(process(rollback, wallet, { reference: refund })).toBeNull();
    expect(rollback.failureCode).toBe(FailureCode.NEGATIVE_BALANCE_PREVENTED);
    expect(wallet.balance.toJSON().amount).toBe(balance);
    expect(wallet.version).toBe(version);
  });

  it('rejects currency and ownership mismatches and forbids reprocessing terminal transactions', () => {
    const wallet = createWallet();
    const wrongCurrencyBet = createTransaction(
      WagerTransactionKind.BET,
      'bet-wrong-currency',
      { currency: 'EUR' },
    );
    expect(process(wrongCurrencyBet, wallet)).toBeNull();
    expect(wrongCurrencyBet.failureCode).toBe(FailureCode.INVALID_CURRENCY);
    expect(wallet.balance.toJSON().amount).toBe('100.00');

    const wrongWalletBet = createTransaction(
      WagerTransactionKind.BET,
      'bet-wrong-wallet',
      { walletId: 'wallet-2' },
    );
    expect(process(wrongWalletBet, wallet)).toBeNull();
    expect(wrongWalletBet.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);

    const processedBet = createTransaction(
      WagerTransactionKind.BET,
      'bet-processed',
    );
    process(processedBet, wallet);
    expect(() => process(processedBet, wallet)).toThrow(
      expect.objectContaining({ failureCode: FailureCode.ALREADY_PROCESSED }),
    );
  });
});
