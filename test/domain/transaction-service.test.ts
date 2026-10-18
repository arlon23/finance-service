import { describe, expect, it } from 'bun:test';
import { DomainError } from '../../src/domain/domain-error.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import {
  canonicalizeJson,
  calculatePayloadHash,
  TransactionService,
} from '../../src/domain/transaction-service.js';
import {
  LedgerEntryType,
  TransactionOperation,
  TransactionStatus,
  transitionTransaction,
  type TransactionCommand,
  type TransactionRecord,
} from '../../src/domain/transaction.js';
import { InMemoryFinancialRepository } from '../../src/infrastructure/in-memory-financial-repository.js';

function setup(balance = '100') {
  const repository = new InMemoryFinancialRepository();
  repository.seedWallet({ id: 'wallet-1', currency: 'USD', balance });
  return { repository, service: new TransactionService(repository) };
}

function command(
  overrides: Partial<TransactionCommand> = {},
): TransactionCommand {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    currency: 'USD',
    roundId: 'round-1',
    operation: TransactionOperation.BET,
    amount: '10',
    ...overrides,
  };
}

function key(value: TransactionCommand): string {
  return `${value.providerId}:${value.externalTransactionId}`;
}

describe('TransactionService', () => {
  it('debits a successful bet and appends a debit ledger entry', async () => {
    const { repository, service } = setup();
    const request = command();

    const result = await service.process(request, key(request));

    expect(result.transaction.status).toBe(TransactionStatus.PROCESSED);
    expect(repository.getWallet('wallet-1')?.balance).toBe('90');
    expect(repository.getLedgerEntries()).toMatchObject([
      { type: LedgerEntryType.DEBIT, amount: '10', currency: 'USD' },
    ]);
  });

  it('rejects a bet with insufficient funds without changing wallet or ledger', async () => {
    const { repository, service } = setup('9.99');
    const request = command();

    const result = await service.process(request, key(request));

    expect(result.transaction.status).toBe(TransactionStatus.REJECTED);
    expect(result.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(repository.getWallet('wallet-1')?.balance).toBe('9.99');
    expect(repository.getLedgerEntries()).toHaveLength(0);
  });

  it('credits wins and records losses without creating ledger entries', async () => {
    const { repository, service } = setup();
    const win = command({
      externalTransactionId: 'win-1',
      operation: TransactionOperation.WIN,
      amount: '4.25',
    });
    await service.process(win, key(win));

    const loss = command({
      externalTransactionId: 'loss-1',
      operation: TransactionOperation.LOSS,
      amount: '10',
    });
    const lossResult = await service.process(loss, key(loss));

    expect(repository.getWallet('wallet-1')?.balance).toBe('104.25');
    expect(repository.getLedgerEntries()).toMatchObject([
      { type: LedgerEntryType.CREDIT, amount: '4.25' },
    ]);
    expect(lossResult.transaction.status).toBe(TransactionStatus.PROCESSED);
    expect(repository.getLedgerEntries()).toHaveLength(1);
  });

  it('refunds a processed bet once and rejects a duplicate reversal', async () => {
    const { repository, service } = setup();
    const bet = command();
    await service.process(bet, key(bet));
    const refund = command({
      externalTransactionId: 'refund-1',
      operation: TransactionOperation.REFUND,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const refundResult = await service.process(refund, key(refund));

    const duplicate = command({
      externalTransactionId: 'refund-2',
      operation: TransactionOperation.REFUND,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const duplicateResult = await service.process(duplicate, key(duplicate));

    expect(refundResult.transaction.status).toBe(TransactionStatus.PROCESSED);
    expect(duplicateResult.transaction.failureCode).toBe(
      FailureCode.DUPLICATE_REFERENCE_REVERSAL,
    );
    expect(repository.getWallet('wallet-1')?.balance).toBe('100');
    expect(repository.getLedgerEntries()).toHaveLength(2);
  });

  it('rolls back a processed bet by crediting its wallet', async () => {
    const { repository, service } = setup();
    const bet = command({ amount: '20' });
    await service.process(bet, key(bet));
    const rollback = command({
      externalTransactionId: 'rollback-1',
      operation: TransactionOperation.ROLLBACK,
      amount: '20',
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const result = await service.process(rollback, key(rollback));

    expect(result.transaction.status).toBe(TransactionStatus.PROCESSED);
    expect(repository.getWallet('wallet-1')?.balance).toBe('100');
    expect(repository.getLedgerEntries()).toMatchObject([
      { type: LedgerEntryType.DEBIT, amount: '20' },
      { type: LedgerEntryType.CREDIT, amount: '20' },
    ]);
  });

  it('rejects a rollback debit that would overdraw the wallet', async () => {
    const { repository, service } = setup('0');
    const win = command({
      externalTransactionId: 'win-to-rollback',
      operation: TransactionOperation.WIN,
      amount: '10',
    });
    await service.process(win, key(win));
    const bet = command({
      externalTransactionId: 'spend-win',
      amount: '8',
    });
    await service.process(bet, key(bet));
    const rollback = command({
      externalTransactionId: 'rollback-win',
      operation: TransactionOperation.ROLLBACK,
      amount: '10',
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const result = await service.process(rollback, key(rollback));

    expect(result.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(repository.getWallet('wallet-1')?.balance).toBe('2');
    expect(repository.getLedgerEntries()).toHaveLength(2);
  });

  it('only permits refunds of bets and enforces round coherence', async () => {
    const { repository, service } = setup();
    const win = command({
      externalTransactionId: 'win-1',
      operation: TransactionOperation.WIN,
      amount: '20',
    });
    await service.process(win, key(win));
    const refundOfWin = command({
      externalTransactionId: 'refund-win',
      operation: TransactionOperation.REFUND,
      amount: '20',
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const rejectedRefund = await service.process(refundOfWin, key(refundOfWin));
    expect(rejectedRefund.transaction.failureCode).toBe(
      FailureCode.REFERENCE_NOT_REVERSIBLE,
    );

    const bet = command({ externalTransactionId: 'bet-round' });
    await service.process(bet, key(bet));
    const wrongRound = command({
      externalTransactionId: 'refund-wrong-round',
      operation: TransactionOperation.REFUND,
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'another-round',
    });
    const rejectedRound = await service.process(wrongRound, key(wrongRound));
    expect(rejectedRound.transaction.failureCode).toBe(
      FailureCode.REFERENCE_MISMATCH,
    );
    expect(repository.getWallet('wallet-1')?.balance).toBe('110');
    expect(repository.getLedgerEntries()).toHaveLength(2);
  });

  it('holds an out-of-order refund pending and reprocesses it after the bet arrives', async () => {
    const { repository, service } = setup();
    const refund = command({
      externalTransactionId: 'refund-1',
      operation: TransactionOperation.REFUND,
      referenceExternalTransactionId: 'bet-late',
    });
    const initial = await service.process(refund, key(refund));
    expect(initial.transaction.status).toBe(
      TransactionStatus.PENDING_REFERENCE,
    );

    const bet = command({
      externalTransactionId: 'bet-late',
      amount: refund.amount,
    });
    await service.process(bet, key(bet));

    const retried = await service.reprocessPending(
      refund.providerId,
      refund.externalTransactionId,
    );
    expect(retried?.status).toBe(TransactionStatus.PROCESSED);
    expect(repository.getWallet('wallet-1')?.balance).toBe('100');
    expect(repository.getLedgerEntries()).toHaveLength(2);
  });

  it('rejects a reference whose currency or wallet does not match', async () => {
    const { repository, service } = setup();
    repository.seedWallet({ id: 'wallet-eur', currency: 'EUR', balance: '50' });
    const bet = command();
    await service.process(bet, key(bet));

    const refund = command({
      externalTransactionId: 'refund-eur',
      operation: TransactionOperation.REFUND,
      walletId: 'wallet-eur',
      currency: 'EUR',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const result = await service.process(refund, key(refund));

    expect(result.transaction.status).toBe(TransactionStatus.REJECTED);
    expect(result.transaction.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
    expect(repository.getWallet('wallet-eur')?.balance).toBe('50');
    expect(repository.getLedgerEntries()).toHaveLength(1);
  });

  it('replays an identical idempotent request and rejects a divergent payload', async () => {
    const { repository, service } = setup();
    const request = command({ amount: '10.00' });
    const first = await service.process(request, key(request));
    const replay = await service.process(
      { ...request, amount: '10' },
      key(request),
    );
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(repository.getTransactions()).toHaveLength(1);
    expect(repository.getTransactions()[0]?.payloadHash).toBe(
      calculatePayloadHash(request),
    );

    const transportMetadataReplay = await service.process(
      { ...request, traceId: 'ignored-transport-metadata' },
      key(request),
    );
    expect(transportMetadataReplay.idempotentReplay).toBe(true);

    await expect(
      service.process({ ...request, amount: '11' }, key(request)),
    ).rejects.toMatchObject({
      failureCode: FailureCode.IDEMPOTENCY_CONFLICT,
    });
    expect(repository.getWallet('wallet-1')?.balance).toBe('90');
    expect(repository.getLedgerEntries()).toHaveLength(1);
  });

  it('serializes concurrent submissions against the persisted transaction key', async () => {
    const { repository, service } = setup();
    const request = command();

    const results = await Promise.all([
      service.process(request, key(request)),
      service.process(request, key(request)),
    ]);

    expect(
      results
        .map(({ idempotentReplay }) => idempotentReplay)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(results[0]?.transaction.id).toBe(results[1]?.transaction.id);
    expect(repository.getTransactions()).toHaveLength(1);
    expect(repository.getWallet('wallet-1')?.balance).toBe('90');
    expect(repository.getLedgerEntries()).toHaveLength(1);
  });

  it('validates the idempotency header and currency format', async () => {
    const { service } = setup();
    const request = command();
    await expect(service.process(request, 'other:key')).rejects.toMatchObject({
      failureCode: FailureCode.INVALID_IDEMPOTENCY_KEY,
    });
    await expect(service.process(request, undefined)).rejects.toMatchObject({
      failureCode: FailureCode.INVALID_IDEMPOTENCY_KEY,
    });

    await expect(
      service.process({ ...request, currency: 'usd' }, key(request)),
    ).rejects.toMatchObject({
      failureCode: FailureCode.INVALID_CURRENCY,
    });

    const refundWithoutReference = command({
      operation: TransactionOperation.REFUND,
    });
    await expect(
      service.process(refundWithoutReference, key(refundWithoutReference)),
    ).rejects.toMatchObject({
      failureCode: FailureCode.INVALID_PAYLOAD,
    });

    await expect(
      service.process({ ...request, amount: '1.000000001' }, key(request)),
    ).rejects.toMatchObject({
      failureCode: FailureCode.INVALID_PAYLOAD,
    });
  });

  it('hashes only canonical business fields in deterministic key order', () => {
    const first = command({ amount: '1.0' });
    const reordered = {
      roundId: first.roundId,
      currency: first.currency,
      walletId: first.walletId,
      playerId: first.playerId,
      externalTransactionId: first.externalTransactionId,
      providerId: first.providerId,
      operation: first.operation,
      amount: '1.00',
    };
    expect(calculatePayloadHash(first)).toBe(calculatePayloadHash(reordered));
    expect(
      canonicalizeJson({
        z: { second: 2, first: 1 },
        a: [{ z: true, b: false }],
      }),
    ).toBe('{"a":[{"b":false,"z":true}],"z":{"first":1,"second":2}}');
  });

  it('enforces legal transaction state transitions', () => {
    const transaction: TransactionRecord = {
      ...command(),
      id: 'transaction-1',
      status: TransactionStatus.PROCESSED,
      payloadHash: 'hash',
      idempotencyKey: 'provider-1:external-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() =>
      transitionTransaction(transaction, TransactionStatus.REJECTED),
    ).toThrow(
      expect.objectContaining({
        failureCode: FailureCode.INVALID_TRANSACTION_STATE,
      }),
    );
    expect(() =>
      transitionTransaction(
        { ...transaction, status: TransactionStatus.NEW },
        TransactionStatus.REJECTED,
      ),
    ).toThrow(DomainError);
  });

  it('does not expose mutable ledger state through repository reads', async () => {
    const { repository, service } = setup();
    const bet = command();
    await service.process(bet, key(bet));
    repository.getLedgerEntries().push({
      id: 'tampered',
      transactionId: 'tampered',
      walletId: 'wallet-1',
      type: LedgerEntryType.CREDIT,
      amount: '1000',
      currency: 'USD',
      createdAt: new Date().toISOString(),
    });
    expect(repository.getLedgerEntries()).toHaveLength(1);
  });
});
