import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { DomainError } from '../../../src/domain/domain-error.js';
import { FailureCode } from '../../../src/domain/failure-code.js';
import {
  calculatePayloadHash,
  TransactionService,
} from '../../../src/domain/transaction-service.js';
import {
  TransactionOperation,
  TransactionStatus,
  type TransactionCommand,
} from '../../../src/domain/transaction.js';
import { PostgresFinancialRepository } from '../../../src/infrastructure/postgres-financial-repository.js';

const schema = `financial_idempotency_${crypto.randomUUID().replaceAll('-', '')}`;
const connection = new URL(
  `postgresql://${encodeURIComponent(process.env.DB_TEST_USER ?? 'postgres')}:${encodeURIComponent(process.env.DB_TEST_PASSWORD ?? 'postgres')}@${process.env.DB_TEST_HOST ?? '127.0.0.1'}:${process.env.DB_TEST_PORT ?? '5433'}/${process.env.DB_TEST_NAME ?? 'financial_test_db'}`,
);
connection.searchParams.set('options', `-c search_path=${schema}`);

let adminClient: Client;
let repository: PostgresFinancialRepository;
let service: TransactionService;

function request(
  overrides: Partial<TransactionCommand> = {},
): TransactionCommand {
  return {
    providerId: 'persisted-provider',
    externalTransactionId: 'persisted-transaction',
    playerId: 'persisted-player',
    walletId: 'persisted-wallet',
    currency: 'USD',
    roundId: 'persisted-round',
    operation: TransactionOperation.BET,
    amount: '12.50',
    ...overrides,
  };
}

function idempotencyKey(command: TransactionCommand): string {
  return `${command.providerId}:${command.externalTransactionId}`;
}

beforeAll(async () => {
  adminClient = new Client({
    host: process.env.DB_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_TEST_PORT ?? '5433'),
    user: process.env.DB_TEST_USER ?? 'postgres',
    password: process.env.DB_TEST_PASSWORD ?? 'postgres',
    database: process.env.DB_TEST_NAME ?? 'financial_test_db',
  });
  await adminClient.connect();
  await adminClient.query(`create schema "${schema}"`);
  await adminClient.query(`set search_path to "${schema}"`);
  await adminClient.query(await readFile('database/schema.sql', 'utf8'));
  await adminClient.query(
    `insert into wallets (id, currency, balance)
     values ('persisted-wallet', 'USD', 100.00)`,
  );

  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connection.toString();
  try {
    repository = new PostgresFinancialRepository();
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
  service = new TransactionService(repository);
});

afterAll(async () => {
  if (repository) {
    await repository.onModuleDestroy();
  }
  if (adminClient) {
    await adminClient.query(`drop schema if exists "${schema}" cascade`);
    await adminClient.end();
  }
});

describe('PostgreSQL-backed transaction idempotency', () => {
  it('persists the canonical hash on the transaction and replays its result', async () => {
    const command = request();
    const key = idempotencyKey(command);
    const original = await service.process(command, key);

    expect(original.idempotentReplay).toBe(false);
    expect(original.transaction.status).toBe(TransactionStatus.PROCESSED);
    const persisted = await adminClient.query<{
      id: string;
      payload_hash: string;
      idempotency_key: string;
      status: string;
    }>(
      `select id, payload_hash, idempotency_key, status
       from financial_transactions
       where idempotency_key = $1`,
      [key],
    );
    expect(persisted.rows).toEqual([
      {
        id: original.transaction.id,
        payload_hash: calculatePayloadHash(command),
        idempotency_key: key,
        status: TransactionStatus.PROCESSED,
      },
    ]);

    const replay = await service.process(
      { ...command, amount: '12.500', requestId: 'ignored' },
      key,
    );
    expect(JSON.parse(JSON.stringify(replay))).toEqual(
      JSON.parse(
        JSON.stringify({
          transaction: original.transaction,
          idempotentReplay: true,
        }),
      ),
    );

    await expect(
      service.process({ ...command, amount: '12.51' }, key),
    ).rejects.toMatchObject({
      failureCode: FailureCode.IDEMPOTENCY_CONFLICT,
    });
    expect(
      await adminClient.query('select id from ledger_entries'),
    ).toMatchObject({
      rowCount: 1,
    });
    expect(
      await adminClient.query(
        `select balance from wallets where id = 'persisted-wallet'`,
      ),
    ).toMatchObject({ rows: [{ balance: '87.50000000' }] });
  });

  it('resolves concurrent duplicate submissions through the transaction unique index', async () => {
    const command = request({
      externalTransactionId: 'concurrent-transaction',
      amount: '7.25',
    });
    const key = idempotencyKey(command);

    const results = await Promise.all([
      service.process(command, key),
      service.process(command, key),
    ]);

    expect(
      results
        .map(({ idempotentReplay }) => idempotentReplay)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(results[0]?.transaction.id).toBe(results[1]?.transaction.id);
    expect(
      await adminClient.query(
        `select count(*)::int as count from financial_transactions
         where idempotency_key = $1`,
        [key],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(
      await adminClient.query(
        `select count(*)::int as count from ledger_entries
         where transaction_id = $1`,
        [results[0]?.transaction.id],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('returns a conflict domain error for a reused key with different business fields', async () => {
    const command = request({
      externalTransactionId: 'conflicting-transaction',
      amount: '3.00',
    });
    const key = idempotencyKey(command);
    await service.process(command, key);

    let error: unknown;
    try {
      await service.process({ ...command, roundId: 'different-round' }, key);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      failureCode: FailureCode.IDEMPOTENCY_CONFLICT,
    });
  });
});
