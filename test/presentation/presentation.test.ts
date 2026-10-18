import { describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Wallet } from '../../src/domain/aggregates/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  WALLET_LEDGER_REPOSITORY,
  WALLET_REPOSITORY,
} from '../../src/application/tokens.js';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { CreateWalletDto } from '../../src/presentation/dtos/create-wallet.dto.js';
import { IdempotencyKeyPipe } from '../../src/presentation/dtos/idempotency-key.pipe.js';
import { LedgerQueryDto } from '../../src/presentation/dtos/ledger-query.dto.js';
import { ProcessWagerTransactionDto } from '../../src/presentation/dtos/process-wager-transaction.dto.js';
import { StrictDtoPipe } from '../../src/presentation/dtos/strict-dto.pipe.js';
import { WalletController } from '../../src/presentation/controllers/wallet.controller.js';
import { WagerController } from '../../src/presentation/controllers/wager.controller.js';

describe('Presentation DTOs', () => {
  it('validates wallet creation fields and supplies the zero-balance default', () => {
    expect(
      CreateWalletDto.parse({ playerId: 'player-1', currency: 'BRL' }),
    ).toMatchObject({
      playerId: 'player-1',
      currency: 'BRL',
      initialBalance: '0.00',
    });
    expect(() =>
      CreateWalletDto.parse({ playerId: ' ', currency: 'BRL' }),
    ).toThrow('playerId must be a non-empty string');
    expect(() =>
      CreateWalletDto.parse({ playerId: 'player-1', currency: 'ZZZ' }),
    ).toThrow('currency must be a valid uppercase ISO 4217 code');
    expect(() =>
      CreateWalletDto.parse({
        playerId: 'player-1',
        currency: 'USD',
        other: true,
      }),
    ).toThrow('Unexpected request field');
  });

  it('validates exact wager fields, amount, kind and required reversal references', () => {
    const payload = {
      providerId: 'provider',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.BET,
      amount: '10.25',
      currency: 'USD',
    };
    expect(ProcessWagerTransactionDto.parse(payload).input).toMatchObject({
      ...payload,
    });
    expect(() =>
      ProcessWagerTransactionDto.parse({ ...payload, amount: 10.25 }),
    ).toThrow('amount must be a non-empty string');
    expect(() =>
      ProcessWagerTransactionDto.parse({ ...payload, amount: '1.234' }),
    ).toThrow('amount has an invalid format');
    expect(() =>
      ProcessWagerTransactionDto.parse({
        ...payload,
        kind: WagerTransactionKind.OPENING,
      }),
    ).toThrow('kind must be BET, WIN, LOSS, REFUND or ROLLBACK');
    expect(() =>
      ProcessWagerTransactionDto.parse({
        ...payload,
        kind: WagerTransactionKind.REFUND,
      }),
    ).toThrow('REFUND requires referenceExternalTransactionId');
  });

  it('validates ledger pagination and requires a correctly formatted idempotency key', () => {
    expect(LedgerQueryDto.parse({ limit: '25', cursor: 'entry-1' })).toEqual({
      limit: 25,
      cursor: 'entry-1',
    });
    expect(() => LedgerQueryDto.parse({ limit: '0' })).toThrow(
      'limit must be between 1 and 100',
    );
    expect(() => new IdempotencyKeyPipe().transform(undefined)).toThrow(
      'Idempotency-Key header is required',
    );
    expect(new IdempotencyKeyPipe().transform('provider:external')).toBe(
      'provider:external',
    );
  });

  it('turns strict validation failures into HTTP 400 exceptions', () => {
    const pipe = new StrictDtoPipe((value) => CreateWalletDto.parse(value));
    expect(() => pipe.transform({ playerId: '', currency: 'USD' })).toThrow(
      'playerId must be a non-empty string',
    );
  });
});

describe('REST controller mapping', () => {
  it('maps wallet creation into the use case and returns a stable wallet DTO', async () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });
    const execute = mock(async () => ({ wallet }));
    const module = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [
        { provide: CreateWalletUseCase, useValue: { execute } },
        {
          provide: WALLET_REPOSITORY,
          useValue: { findById: async () => wallet },
        },
        { provide: WALLET_LEDGER_REPOSITORY, useValue: {} },
      ],
    }).compile();

    const controller = module.get(WalletController);
    const dto = CreateWalletDto.parse({
      playerId: 'player-1',
      currency: 'BRL',
      initialBalance: '0.00',
    });
    const result = await controller.create(dto);

    expect(execute).toHaveBeenCalledWith({
      playerId: 'player-1',
      currency: 'BRL',
      initialBalance: '0.00',
    });
    expect(result).toMatchObject({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    await module.close();
  });

  it('maps wallet ledger entries into a cursor-paginated response', async () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
    });
    const firstEntry = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: wallet.id,
      transactionId: 'transaction-2',
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      balanceBefore: Money.from({ amount: '10.00', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '9.00', currency: 'USD' }),
    });
    const nextEntry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: wallet.id,
      transactionId: 'transaction-1',
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      balanceBefore: Money.from({ amount: '9.00', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '8.00', currency: 'USD' }),
    });
    const findByWalletId = mock(async () => [firstEntry, nextEntry]);
    const module = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [
        {
          provide: CreateWalletUseCase,
          useValue: { execute: async () => ({ wallet }) },
        },
        {
          provide: WALLET_REPOSITORY,
          useValue: { findById: async () => wallet },
        },
        {
          provide: WALLET_LEDGER_REPOSITORY,
          useValue: { findByWalletId },
        },
      ],
    }).compile();

    const controller = module.get(WalletController);
    const result = await controller.findLedger(
      wallet.id,
      LedgerQueryDto.parse({ limit: '1' }),
    );

    expect(findByWalletId).toHaveBeenCalledWith(wallet.id, { limit: 2 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 'entry-2',
      direction: LedgerDirection.DEBIT,
      money: { amount: '1.00', currency: 'USD' },
      balanceAfter: { amount: '9.00', currency: 'USD' },
    });
    expect(result.nextCursor).toBe('entry-2');
    await module.close();
  });

  it('forwards the required idempotency key and maps a rejected wager to HTTP 422', async () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'transaction-1',
      providerId: 'provider',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      idempotencyKey: 'provider:external-1',
      payloadHash: 'a'.repeat(64),
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: '2.00', currency: 'USD' }),
      status: WagerTransactionStatus.REJECTED,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
      resultingBalance: Money.zero('USD'),
    });
    const execute = mock(async () => ({
      transaction,
      walletBalance: { amount: '0.00', currency: 'USD' },
      idempotentReplay: false,
    }));
    const module = await Test.createTestingModule({
      controllers: [WagerController],
      providers: [
        {
          provide: ProcessWagerTransactionUseCase,
          useValue: { execute },
        },
      ],
    }).compile();

    const controller = module.get(WagerController);
    const payload = ProcessWagerTransactionDto.parse({
      providerId: 'provider',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.BET,
      amount: '2.00',
      currency: 'USD',
    });
    const response = { status: mock((_status: number) => undefined) };
    const result = await controller.process(
      payload,
      'provider:external-1',
      response,
    );

    expect(execute).toHaveBeenCalledWith(payload.input, 'provider:external-1');
    expect(response.status).toHaveBeenCalledWith(422);
    expect(result).toMatchObject({
      transaction: {
        id: 'transaction-1',
        status: WagerTransactionStatus.REJECTED,
        amount: { amount: '2.00', currency: 'USD' },
      },
      idempotentReplay: false,
    });
    await module.close();
  });
});
