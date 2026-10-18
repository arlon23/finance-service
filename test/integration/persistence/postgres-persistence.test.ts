import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/core';
import { Client } from 'pg';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
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
import { Money } from '../../../src/domain/value-objects/money.js';
import { FailureCode } from '../../../src/domain/failure-code.js';
import { CreateWalletUseCase } from '../../../src/application/use-cases/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/process-wager-transaction.use-case.js';
import type { ProcessWagerTransactionInput } from '../../../src/application/use-cases/process-wager-transaction.use-case.js';
import { InboxMessageEntity } from '../../../src/infrastructure/persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../../../src/infrastructure/persistence/entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../../src/infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../../src/infrastructure/persistence/entities/wallet.entity.js';
import { Migration20261016190456_CreateFinancialPersistence } from '../../../src/infrastructure/persistence/migrations/Migration20261016190456_CreateFinancialPersistence.js';
import { Migration20261016190500_AddWagerTransactionUpdatedAt } from '../../../src/infrastructure/persistence/migrations/Migration20261016190500_AddWagerTransactionUpdatedAt.js';
import { Migration20261017085000_AddWagerTransactionResultingBalance } from '../../../src/infrastructure/persistence/migrations/Migration20261017085000_AddWagerTransactionResultingBalance.js';
import { Migration20261017181500_OptimizeOutboxPendingLookup } from '../../../src/infrastructure/persistence/migrations/Migration20261017181500_OptimizeOutboxPendingLookup.js';
import { Migration20261018130000_AddInboxCorrelationId } from '../../../src/infrastructure/persistence/migrations/Migration20261018130000_AddInboxCorrelationId.js';
import { InboxRepository } from '../../../src/infrastructure/persistence/repositories/inbox.repository.js';
import { OutboxRepository } from '../../../src/infrastructure/persistence/repositories/outbox.repository.js';
import { WalletLedgerRepository } from '../../../src/infrastructure/persistence/repositories/wallet-ledger.repository.js';
import { WagerTransactionRepository } from '../../../src/infrastructure/persistence/repositories/wager-transaction.repository.js';
import { WalletRepository } from '../../../src/infrastructure/persistence/repositories/wallet.repository.js';
import {
  DEFAULT_OUTBOX_PROCESSOR_OPTIONS,
  OutboxProcessor,
  type OutboxProcessorOptions,
} from '../../../src/application/workers/outbox-processor.js';
import { SqsOutboxPublisher } from '../../../src/infrastructure/messaging/sqs-outbox-publisher.js';
import { WagerTransactionConsumer } from '../../../src/application/workers/wager-transaction-consumer.js';
import { calculateWagerPayloadHash } from '../../../src/application/payload-hash.js';
import { correlationContext } from '../../../src/infrastructure/logging/correlation-context.js';
import type { OutboxEventPublisher } from '../../../src/application/ports/financial-persistence.js';
import type { EntityManager } from '@mikro-orm/core';

const database = {
  host: process.env.DB_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_TEST_PORT ?? '5433'),
  user: process.env.DB_TEST_USER ?? 'postgres',
  password: process.env.DB_TEST_PASSWORD ?? 'postgres',
  dbName: process.env.DB_TEST_NAME ?? 'financial_test_db',
};
const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
const sqsEndpoint = process.env.SQS_TEST_ENDPOINT ?? 'http://127.0.0.1:4566';
const queueName = `financial-outbox-${crypto.randomUUID()}.fifo`;
const migrations = [
  Migration20261016190456_CreateFinancialPersistence,
  Migration20261016190500_AddWagerTransactionUpdatedAt,
  Migration20261017085000_AddWagerTransactionResultingBalance,
  Migration20261017181500_OptimizeOutboxPendingLookup,
  Migration20261018130000_AddInboxCorrelationId,
];

let orm: MikroORM;
let adminClient: Client;
let wallets: WalletRepository;
let transactions: WagerTransactionRepository;
let ledger: WalletLedgerRepository;
let inbox: InboxRepository;
let outbox: OutboxRepository;
let createWallet: CreateWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;
let sqs: SQSClient;
let queueUrl: string;

function makeWallet(
  id = crypto.randomUUID(),
  playerId = crypto.randomUUID(),
  amount = '125.67',
): Wallet {
  return Wallet.open({
    id,
    playerId,
    initialBalance: Money.from({ amount, currency: 'USD' }),
  });
}

function makeTransaction(
  walletId: string,
  options: {
    id?: string;
    providerId?: string;
    externalTransactionId?: string;
    amount?: string;
  } = {},
): WagerTransaction {
  const providerId = options.providerId ?? 'integration-provider';
  const externalTransactionId =
    options.externalTransactionId ?? crypto.randomUUID();
  return WagerTransaction.rehydrate({
    id: options.id ?? crypto.randomUUID(),
    providerId,
    externalTransactionId,
    playerId: crypto.randomUUID(),
    walletId,
    roundId: crypto.randomUUID(),
    gameId: 'integration-game',
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    kind: WagerTransactionKind.BET,
    money: Money.from({ amount: options.amount ?? '0.10', currency: 'USD' }),
    status: WagerTransactionStatus.PENDING,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

async function expectPostgresError(
  work: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let caught: unknown;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();

  let current: unknown = caught;
  let postgresCode: unknown;
  while (current instanceof Error) {
    const pgError = current as Error & { code?: string };
    postgresCode ??= pgError.code;
    current = pgError.cause;
  }
  expect(postgresCode).toBe(expectedCode);
}

async function withTransaction<T>(
  work: (transactionalEm: EntityManager) => Promise<T>,
): Promise<T> {
  return orm.em.transactional((transactionalEm) =>
    work(transactionalEm as EntityManager),
  );
}

function makeOutboxProcessor(
  publisher: OutboxEventPublisher,
  options: Partial<OutboxProcessorOptions> = {},
  em: EntityManager = orm.em,
): OutboxProcessor {
  return new OutboxProcessor(em, outbox, publisher, {
    ...DEFAULT_OUTBOX_PROCESSOR_OPTIONS,
    ...options,
  });
}

function makeWagerConsumer(
  consumerName = 'integration-wager-consumer',
  client = sqs,
  useCase = processWager,
  configuredQueueUrl = queueUrl,
): WagerTransactionConsumer {
  return new WagerTransactionConsumer(
    orm.em.fork({ clear: true }),
    inbox,
    useCase,
    client,
    {
      consumerName,
      queueUrl: configuredQueueUrl,
      pollIntervalMs: 100,
      batchSize: 10,
      waitTimeSeconds: 2,
      visibilityTimeoutSeconds: 0,
      shutdownTimeoutMs: 30_000,
    },
  );
}

async function receiveQueueMessages(maxMessages = 10) {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 2,
      MessageAttributeNames: ['All'],
    }),
  );
  const messages = result.Messages ?? [];
  for (const message of messages) {
    if (message.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
  return messages;
}

beforeAll(async () => {
  adminClient = new Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.dbName,
  });
  await adminClient.connect();
  await adminClient.query(`create schema "${schema}"`);
  sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: sqsEndpoint,
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
    maxAttempts: 1,
  });
  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
      },
    }),
  );
  if (!queue.QueueUrl) {
    throw new Error('LocalStack did not return the outbox test queue URL');
  }
  queueUrl = queue.QueueUrl;

  orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    ...database,
    schema,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],
    migrations: {
      migrationsList: migrations,
      schema,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
    },
    allowGlobalContext: true,
  });
  await orm.migrator.up({ schema });

  wallets = new WalletRepository(orm.em);
  transactions = new WagerTransactionRepository(orm.em);
  ledger = new WalletLedgerRepository(orm.em);
  inbox = new InboxRepository(orm.em);
  outbox = new OutboxRepository(orm.em);
  createWallet = new CreateWalletUseCase(
    orm.em,
    wallets,
    transactions,
    ledger,
    outbox,
  );
  processWager = new ProcessWagerTransactionUseCase(
    orm.em,
    wallets,
    transactions,
    ledger,
    outbox,
  );
});

afterAll(async () => {
  if (sqs && queueUrl) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    sqs.destroy();
  }
  if (orm) {
    await orm.close(true);
  }
  if (adminClient) {
    await adminClient.query(`drop schema if exists "${schema}" cascade`);
    await adminClient.end();
  }
});

describe('MikroORM PostgreSQL persistence', () => {
  it('runs migrations and creates the required tables, constraints and indexes', async () => {
    const tables = await adminClient.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE'`,
      [schema],
    );
    expect(tables.rows.map(({ table_name }) => table_name).sort()).toEqual([
      'inbox_messages',
      'mikro_orm_migrations',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    const constraints = await adminClient.query<{ conname: string }>(
      `select conname
       from pg_constraint
       where connamespace = $1::regnamespace`,
      [schema],
    );
    const constraintNames = constraints.rows.map(({ conname }) => conname);
    expect(constraintNames).toContain('wallets_player_currency_uq');
    expect(constraintNames).toContain('wallets_balance_nonnegative_ck');
    expect(constraintNames).toContain('wager_transactions_idempotency_key_uq');
    expect(constraintNames).toContain(
      'wager_transactions_provider_external_uq',
    );

    const indexes = await adminClient.query<{ indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = $1`,
      [schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'wallet_ledger_entries_wallet_created_idx',
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'outbox_messages_pending_schedule_idx',
    );

    const updatedAtColumn = await adminClient.query(
      `select 1
       from information_schema.columns
       where table_schema = $1
         and table_name = 'wager_transactions'
         and column_name = 'updated_at'`,
      [schema],
    );
    expect(updatedAtColumn.rowCount).toBe(1);
  });

  it('enforces wallet uniqueness and non-negative balance in PostgreSQL', async () => {
    const first = makeWallet();
    await wallets.save(first);
    await expectPostgresError(
      () =>
        wallets.save(makeWallet(crypto.randomUUID(), first.playerId, '50.00')),
      '23505',
    );

    await expectPostgresError(
      () =>
        orm.em
          .getConnection()
          .execute(
            `update "${schema}"."wallets" set "balance" = -0.01 where "id" = ?`,
            [first.id],
          ),
      '23514',
    );
    orm.em.clear();
  });

  it('rejects duplicate idempotency keys through their unique database constraint', async () => {
    const wallet = makeWallet();
    await wallets.save(wallet);
    const transaction = makeTransaction(wallet.id);
    await transactions.save(transaction);

    await expectPostgresError(
      () =>
        transactions.save(
          makeTransaction(wallet.id, {
            id: crypto.randomUUID(),
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
          }),
        ),
      '23505',
    );
    orm.em.clear();
  });

  it('round-trips wallet, transaction and ledger values through repositories', async () => {
    const wallet = makeWallet(
      crypto.randomUUID(),
      crypto.randomUUID(),
      '999.99',
    );
    const transaction = makeTransaction(wallet.id, { amount: '0.10' });
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '0.10', currency: 'USD' }),
      balanceBefore: Money.from({ amount: '1000.09', currency: 'USD' }),
      balanceAfter: Money.from({ amount: '999.99', currency: 'USD' }),
    });

    await wallets.save(wallet);
    await transactions.save(transaction);
    await ledger.save(entry);
    orm.em.clear();

    const restoredWallet = await wallets.findById(wallet.id);
    const restoredTransaction = await transactions.findByIdempotencyKey(
      transaction.idempotencyKey,
    );
    const restoredLedger = await ledger.findByWalletId(wallet.id);
    expect(restoredWallet?.balance.toJSON()).toEqual({
      amount: '999.99',
      currency: 'USD',
    });
    expect(restoredTransaction?.money.toJSON()).toEqual({
      amount: '0.10',
      currency: 'USD',
    });
    expect(restoredTransaction?.gameId).toBe('integration-game');
    expect(restoredLedger).toHaveLength(1);
    expect(restoredLedger[0]?.balanceBefore.toJSON()).toEqual({
      amount: '1000.09',
      currency: 'USD',
    });
    expect(restoredLedger[0]?.balanceAfter.toJSON()).toEqual({
      amount: '999.99',
      currency: 'USD',
    });
  });

  it('commits wallet, ledger, inbox and outbox writes together', async () => {
    const wallet = makeWallet();
    const transaction = makeTransaction(wallet.id);
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '0.10', currency: 'USD' }),
      balanceBefore: wallet.balance,
      balanceAfter: wallet.balance.subtract(
        Money.from({ amount: '0.10', currency: 'USD' }),
      ),
    });
    const inboxMessage = {
      consumerName: 'integration-consumer',
      messageId: crypto.randomUUID(),
      payloadHash: 'c'.repeat(64),
      correlationId: 'db-integration-correlation',
    };
    const outboxMessage = {
      id: crypto.randomUUID(),
      aggregateId: wallet.id,
      eventType: 'WalletDebited',
      payload: { transactionId: transaction.id },
    };

    await withTransaction(async (transactionalEm) => {
      await wallets.save(wallet, transactionalEm);
      await transactions.save(transaction, transactionalEm);
      await ledger.save(entry, transactionalEm);
      expect(await inbox.claim(inboxMessage, transactionalEm)).toBe(true);
      await outbox.save(outboxMessage, transactionalEm);
    });

    orm.em.clear();
    expect(await wallets.findById(wallet.id)).not.toBeNull();
    expect(await transactions.findById(transaction.id)).not.toBeNull();
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(1);
    expect(await inbox.claim(inboxMessage)).toBe(false);
    expect(
      await inbox.find(inboxMessage.consumerName, inboxMessage.messageId),
    ).toMatchObject({ correlationId: 'db-integration-correlation' });
    await expect(
      inbox.claim({ ...inboxMessage, payloadHash: 'd'.repeat(64) }),
    ).rejects.toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT' });
    expect(
      (await outbox.findPending()).some(({ id }) => id === outboxMessage.id),
    ).toBe(true);
  });

  it('rolls wallet, transaction, ledger, inbox and outbox writes back atomically', async () => {
    const wallet = makeWallet();
    const transaction = makeTransaction(wallet.id);
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: '0.10', currency: 'USD' }),
      balanceBefore: wallet.balance,
      balanceAfter: wallet.balance.subtract(
        Money.from({ amount: '0.10', currency: 'USD' }),
      ),
    });
    const inboxMessage = {
      consumerName: 'integration-consumer',
      messageId: crypto.randomUUID(),
      payloadHash: 'b'.repeat(64),
    };
    const outboxMessage = {
      id: crypto.randomUUID(),
      aggregateId: wallet.id,
      eventType: 'WalletDebited',
      payload: { transactionId: transaction.id },
    };

    await expect(
      withTransaction(async (transactionalEm) => {
        await wallets.save(wallet, transactionalEm);
        await transactions.save(transaction, transactionalEm);
        await ledger.save(entry, transactionalEm);
        expect(await inbox.claim(inboxMessage, transactionalEm)).toBe(true);
        await outbox.save(outboxMessage, transactionalEm);
        throw new Error('force transaction rollback');
      }),
    ).rejects.toThrow('force transaction rollback');

    orm.em.clear();
    expect(await wallets.findById(wallet.id)).toBeNull();
    expect(await transactions.findById(transaction.id)).toBeNull();
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(0);
    const inboxRow = await adminClient.query(
      `select 1 from "${schema}"."inbox_messages"
       where "consumer_name" = $1 and "message_id" = $2`,
      [inboxMessage.consumerName, inboxMessage.messageId],
    );
    const outboxRow = await adminClient.query(
      `select 1 from "${schema}"."outbox_messages" where "id" = $1`,
      [outboxMessage.id],
    );
    expect(inboxRow.rowCount).toBe(0);
    expect(outboxRow.rowCount).toBe(0);
  });
});

describe('financial application use cases', () => {
  function wagerInput(
    wallet: Wallet,
    overrides: Partial<ProcessWagerTransactionInput> = {},
  ): ProcessWagerTransactionInput {
    const providerId = overrides.providerId ?? 'use-case-provider';
    const externalTransactionId =
      overrides.externalTransactionId ?? crypto.randomUUID();
    return {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: crypto.randomUUID(),
      gameId: 'use-case-game',
      kind: WagerTransactionKind.BET,
      amount: '1.00',
      currency: wallet.currency,
      ...overrides,
      idempotencyKey:
        overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    };
  }

  it('creates zero-balance wallets and atomically records positive opening balances', async () => {
    const zeroWallet = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '0.00',
    });
    expect(zeroWallet.wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
    expect(zeroWallet.openingTransaction).toBeUndefined();
    expect(await ledger.findByWalletId(zeroWallet.wallet.id)).toHaveLength(0);

    const correlationId = `wallet-open-${crypto.randomUUID()}`;
    const fundedWallet = await correlationContext.runWithCorrelationId(
      correlationId,
      () =>
        createWallet.execute({
          playerId: crypto.randomUUID(),
          currency: 'USD',
          initialBalance: '25.50',
        }),
    );
    expect(fundedWallet.wallet.balance.toJSON()).toEqual({
      amount: '25.50',
      currency: 'USD',
    });
    expect(fundedWallet.openingTransaction?.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(await ledger.findByWalletId(fundedWallet.wallet.id)).toHaveLength(1);
    const walletOpenedEvent = (await outbox.findPending()).find(
      ({ aggregateId, eventType }) =>
        aggregateId === fundedWallet.wallet.id && eventType === 'WalletOpened',
    );
    expect(walletOpenedEvent?.payload).toMatchObject({ correlationId });

    await expect(
      createWallet.execute({
        playerId: fundedWallet.wallet.playerId,
        currency: 'USD',
        initialBalance: '0.00',
      }),
    ).rejects.toMatchObject({
      failureCode: FailureCode.WALLET_ALREADY_EXISTS,
    });
  });

  describe('Transactional outbox processing with PostgreSQL and LocalStack SQS', () => {
    const options = {
      batchSize: 1,
      pollIntervalMs: 100,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 800,
    };

    beforeAll(async () => {
      await adminClient.query(
        `update "${schema}".outbox_messages
         set published_at = now(), next_attempt_at = null
         where published_at is null`,
      );
    });

    function publisherFor(url: string): SqsOutboxPublisher {
      return new SqsOutboxPublisher(sqs, { WalletBalanceChanged: url });
    }

    it('waits for an active outbox transaction before graceful shutdown', async () => {
      const messageId = crypto.randomUUID();
      await outbox.save({
        id: messageId,
        aggregateId: crypto.randomUUID(),
        eventType: 'WalletBalanceChanged',
        payload: { eventId: messageId },
      });

      let releasePublish!: () => void;
      let markPublishing!: () => void;
      const publishingStarted = new Promise<void>((resolve) => {
        markPublishing = resolve;
      });
      const waitToPublish = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      let publisherClosed = false;
      const processor = makeOutboxProcessor(
        {
          async publish() {
            markPublishing();
            await waitToPublish;
          },
          close() {
            publisherClosed = true;
          },
        },
        { ...options, shutdownTimeoutMs: 1_000 },
      );
      processor.onModuleInit();
      await publishingStarted;

      let shutdownComplete = false;
      const shutdown = processor.onModuleDestroy().then(() => {
        shutdownComplete = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownComplete).toBe(false);
      releasePublish();
      await shutdown;

      expect(shutdownComplete).toBe(true);
      expect(publisherClosed).toBe(true);
      const persisted = await outbox.findPending({
        limit: 10,
      });
      expect(persisted.some(({ id }) => id === messageId)).toBe(false);
    });

    it('does not publish uncommitted outbox messages and publishes after commit', async () => {
      const messageId = crypto.randomUUID();
      const correlationId = `outbox-correlation-${crypto.randomUUID()}`;
      const processor = makeOutboxProcessor(
        publisherFor(queueUrl),
        options,
        orm.em.fork({ clear: true }),
      );
      let beforeCommit:
        { claimed: number; published: number; retried: number } | undefined;

      await withTransaction(async (em) => {
        await outbox.save(
          {
            id: messageId,
            aggregateId: crypto.randomUUID(),
            eventType: 'WalletBalanceChanged',
            payload: {
              eventId: messageId,
              eventType: 'WalletBalanceChanged',
              correlationId,
            },
          },
          em,
        );
        beforeCommit = await processor.processBatch();
      });

      expect(beforeCommit?.claimed).toBe(0);
      expect(await receiveQueueMessages()).toHaveLength(0);
      expect((await processor.processBatch()).published).toBe(1);
      const messages = await receiveQueueMessages();
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0]?.Body ?? '{}').eventId).toBe(messageId);
      expect(messages[0]?.MessageAttributes?.correlationId?.StringValue).toBe(
        correlationId,
      );
      expect((await processor.processBatch()).claimed).toBe(0);
    });

    it('lets concurrent publishers claim disjoint rows using PostgreSQL SKIP LOCKED', async () => {
      const eventIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (const id of eventIds) {
        await outbox.save({
          id,
          aggregateId: crypto.randomUUID(),
          eventType: 'WalletBalanceChanged',
          payload: { eventId: id, eventType: 'WalletBalanceChanged' },
        });
      }

      const delayedPublisher: OutboxEventPublisher = {
        async publish(message) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          await publisherFor(queueUrl).publish(message);
        },
      };
      const first = makeOutboxProcessor(delayedPublisher, options);
      const second = makeOutboxProcessor(delayedPublisher, options);
      const results = await Promise.all([
        first.processBatch(),
        second.processBatch(),
      ]);
      expect(results.map(({ published }) => published)).toEqual([1, 1]);

      const messages = await receiveQueueMessages();
      expect(messages).toHaveLength(2);
      const sentIds = messages.map(
        ({ MessageAttributes }) => MessageAttributes?.eventId?.StringValue,
      );
      expect(new Set(sentIds)).toEqual(new Set(eventIds));
      expect((await first.processBatch()).claimed).toBe(0);
    });

    it('records exponential retry scheduling after a real SQS publish failure', async () => {
      const messageId = crypto.randomUUID();
      await outbox.save({
        id: messageId,
        aggregateId: crypto.randomUUID(),
        eventType: 'WalletBalanceChanged',
        payload: { eventId: messageId, eventType: 'WalletBalanceChanged' },
      });
      const now = new Date();
      const badQueue = `${sqsEndpoint}/000000000000/missing-outbox-queue`;
      const processor = makeOutboxProcessor(publisherFor(badQueue), options);
      const failedBatch = await processor.processBatch(now);

      expect(failedBatch).toMatchObject({
        claimed: 1,
        published: 0,
        retried: 1,
      });
      const pendingMessage = (
        await outbox.findPending({
          limit: 1,
          now: new Date(now.getTime() + 99),
        })
      ).find(({ id }) => id === messageId);
      expect(pendingMessage).toBeUndefined();

      const dueMessages = await outbox.findPending({
        limit: 10,
        now: new Date(now.getTime() + 100),
      });
      const retryingMessage = dueMessages.find(({ id }) => id === messageId);
      expect(retryingMessage?.attempts).toBe(1);
      expect(retryingMessage?.nextAttemptAt?.getTime()).toBe(
        now.getTime() + 100,
      );

      const recovered = await makeOutboxProcessor(
        publisherFor(queueUrl),
        options,
      ).processBatch(new Date(now.getTime() + 100));
      expect(recovered).toMatchObject({ claimed: 1, published: 1, retried: 0 });
      const published = await receiveQueueMessages();
      expect(published).toHaveLength(1);
      expect(JSON.parse(published[0]?.Body ?? '{}').eventId).toBe(messageId);
    });
  });

  describe('SQS wager inbox consumer', () => {
    it('does not repeat financial effects when a committed message is redelivered', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '100.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        amount: '12.34',
      });
      const idempotencyKey = `${input.providerId}:${input.externalTransactionId}`;
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
        }),
      );

      const firstDelivery = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
        }),
      );
      const originalMessage = firstDelivery.Messages?.[0];
      if (!originalMessage?.MessageId || !originalMessage.Body) {
        throw new Error('SQS did not return the wager message for delivery');
      }
      const payloadHash = calculateWagerPayloadHash(input);
      await withTransaction(async (em) => {
        expect(
          await inbox.claim(
            {
              consumerName,
              messageId: originalMessage.MessageId!,
              payloadHash,
            },
            em,
          ),
        ).toBe(true);
        await processWager.execute(input, idempotencyKey, em);
        await inbox.markProcessed(
          consumerName,
          originalMessage.MessageId!,
          new Date(),
          em,
        );
      });

      const redelivery = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
        }),
      );
      const redeliveredMessage = redelivery.Messages?.[0];
      expect(redeliveredMessage?.MessageId).toBe(originalMessage.MessageId);
      if (!redeliveredMessage) {
        throw new Error('SQS did not redeliver the unacknowledged message');
      }

      const consumer = makeWagerConsumer(consumerName);
      await consumer.processMessage(redeliveredMessage);

      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '87.66',
        currency: 'USD',
      });
      expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
      expect(
        await inbox.find(consumerName, originalMessage.MessageId!),
      ).toMatchObject({ processedAt: expect.any(Date) });
      const transaction = await transactions.findByProviderAndExternalId(
        input.providerId,
        input.externalTransactionId,
      );
      expect(transaction).not.toBeNull();
      expect(await receiveQueueMessages()).toHaveLength(0);
    });

    it('serializes concurrent deliveries through the persistent inbox and wager idempotency', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '50.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        amount: '7.00',
      });
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
        }),
      );
      const deliveryOptions = {
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 0,
      };
      const [firstDelivery, duplicateDelivery] = await Promise.all([
        sqs.send(new ReceiveMessageCommand(deliveryOptions)),
        sqs.send(new ReceiveMessageCommand(deliveryOptions)),
      ]);
      const firstMessage = firstDelivery.Messages?.[0];
      const duplicateMessage = duplicateDelivery.Messages?.[0];
      if (
        !firstMessage?.MessageId ||
        !firstMessage.ReceiptHandle ||
        !duplicateMessage?.MessageId ||
        !duplicateMessage.ReceiptHandle ||
        firstMessage.MessageId !== duplicateMessage.MessageId
      ) {
        throw new Error(
          'LocalStack did not return concurrent SQS redeliveries',
        );
      }

      const firstConsumer = makeWagerConsumer(consumerName);
      const secondConsumer = makeWagerConsumer(consumerName);
      await Promise.all([
        firstConsumer.processMessage(firstMessage),
        secondConsumer.processMessage(duplicateMessage),
      ]);

      orm.em.clear();
      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '43.00',
        currency: 'USD',
      });
      expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
      expect(
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        ),
      ).not.toBeNull();
      const inboxRows = await adminClient.query(
        `select "message_id" from "${schema}"."inbox_messages"
         where "consumer_name" = $1`,
        [consumerName],
      );
      expect(inboxRows.rowCount).toBe(1);
      expect(await receiveQueueMessages()).toHaveLength(0);
    });

    it('recovers a committed message when the SQS ACK fails', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '30.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        amount: '4.00',
      });
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
        }),
      );

      const delivery = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
        }),
      );
      const message = delivery.Messages?.[0];
      if (!message?.MessageId || !message.Body || !message.ReceiptHandle) {
        throw new Error('SQS did not return the message for ACK failure test');
      }

      const failingAckClient = new SQSClient({
        region: 'us-east-1',
        endpoint: sqsEndpoint,
        credentials: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
      });
      try {
        const failingAckConsumer = makeWagerConsumer(
          consumerName,
          failingAckClient,
          processWager,
          `${sqsEndpoint}/000000000000/missing-ack-queue.fifo`,
        );
        await expect(
          failingAckConsumer.processMessage(message),
        ).rejects.toThrow();
      } finally {
        failingAckClient.destroy();
      }

      orm.em.clear();
      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '26.00',
        currency: 'USD',
      });
      expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
      expect(await inbox.find(consumerName, message.MessageId)).toMatchObject({
        processedAt: expect.any(Date),
      });

      const redelivery = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
        }),
      );
      const redeliveredMessage = redelivery.Messages?.[0];
      expect(redeliveredMessage?.MessageId).toBe(message.MessageId);
      if (!redeliveredMessage) {
        throw new Error('SQS did not redeliver after the failed ACK');
      }
      await makeWagerConsumer(consumerName).processMessage(redeliveredMessage);

      orm.em.clear();
      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '26.00',
        currency: 'USD',
      });
      expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
      expect(await receiveQueueMessages()).toHaveLength(0);
    });

    it('leaves failed messages unacknowledged and retries them after recovery', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '10.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        amount: '1.00',
      });
      const correlationId = `consumer-correlation-${crypto.randomUUID()}`;
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      const triggerName = `fail_inbox_${crypto.randomUUID().replaceAll('-', '')}`;
      const functionName = `fail_inbox_fn_${crypto.randomUUID().replaceAll('-', '')}`;
      await adminClient.query(`
        create function "${schema}"."${functionName}"()
        returns trigger language plpgsql as $$
        begin
          raise exception 'simulated transient inbox storage failure';
        end;
        $$;
        create trigger "${triggerName}"
        before update of "processed_at" on "${schema}"."inbox_messages"
        for each row when (new.processed_at is not null)
        execute function "${schema}"."${functionName}"();
      `);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
          MessageAttributes: {
            correlationId: {
              DataType: 'String',
              StringValue: correlationId,
            },
          },
        }),
      );

      const consumer = makeWagerConsumer(consumerName);
      expect(await consumer.pollOnce()).toEqual({
        received: 1,
        acknowledged: 0,
      });
      expect(
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        ),
      ).toBeNull();
      const inboxRows = await adminClient.query(
        `select 1 from "${schema}"."inbox_messages"
         where "consumer_name" = $1`,
        [consumerName],
      );
      expect(inboxRows.rowCount).toBe(0);

      await adminClient.query(`
        drop trigger "${triggerName}" on "${schema}"."inbox_messages";
        drop function "${schema}"."${functionName}"();
      `);
      expect(await consumer.pollOnce()).toEqual({
        received: 1,
        acknowledged: 1,
      });
      const recoveredTransaction =
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        );
      expect(recoveredTransaction?.status).toBe(
        WagerTransactionStatus.PROCESSED,
      );
      orm.em.clear();
      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '9.00',
        currency: 'USD',
      });
      const persistedInbox = await adminClient.query<{
        correlation_id: string | null;
      }>(
        `select "correlation_id" from "${schema}"."inbox_messages"
         where "consumer_name" = $1`,
        [consumerName],
      );
      expect(persistedInbox.rows).toEqual([{ correlation_id: correlationId }]);
      expect(await receiveQueueMessages()).toHaveLength(0);
    });

    it('records and acknowledges terminal business payload failures', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '10.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        currency: 'US',
      });
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
        }),
      );

      expect(await makeWagerConsumer(consumerName).pollOnce()).toEqual({
        received: 1,
        acknowledged: 1,
      });
      expect(await receiveQueueMessages()).toHaveLength(0);
      const recordedInbox = await adminClient.query<{
        processed_at: Date | null;
      }>(
        `select "processed_at" from "${schema}"."inbox_messages"
         where "consumer_name" = $1`,
        [consumerName],
      );
      expect(recordedInbox.rows).toHaveLength(1);
      expect(recordedInbox.rows[0]?.processed_at).toBeInstanceOf(Date);
      expect(
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        ),
      ).toBeNull();
    });

    it('drains the active transaction before stopping the SQS consumer', async () => {
      const { wallet } = await createWallet.execute({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '20.00',
      });
      const input = wagerInput(wallet, {
        externalTransactionId: crypto.randomUUID(),
        amount: '2.00',
      });
      const consumerName = `wager-consumer-${crypto.randomUUID()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(input),
          MessageGroupId: consumerName,
        }),
      );

      let releaseTransaction!: () => void;
      let markTransactionStarted!: () => void;
      const transactionStarted = new Promise<void>((resolve) => {
        markTransactionStarted = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      class PausedWagerUseCase extends ProcessWagerTransactionUseCase {
        override async execute(
          wagerInput: ProcessWagerTransactionInput,
          key?: string,
          em?: EntityManager,
        ) {
          markTransactionStarted();
          await waitForRelease;
          return super.execute(wagerInput, key, em);
        }
      }
      const pausedUseCase = new PausedWagerUseCase(
        orm.em,
        wallets,
        transactions,
        ledger,
        outbox,
      );
      const consumerClient = new SQSClient({
        region: 'us-east-1',
        endpoint: sqsEndpoint,
        credentials: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
      });
      const consumer = makeWagerConsumer(
        consumerName,
        consumerClient,
        pausedUseCase,
      );
      consumer.onModuleInit();
      await transactionStarted;

      let shutdownComplete = false;
      const shutdown = consumer.onModuleDestroy().then(() => {
        shutdownComplete = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownComplete).toBe(false);
      releaseTransaction();
      await shutdown;

      expect(shutdownComplete).toBe(true);
      expect(await consumer.pollOnce()).toEqual({
        received: 0,
        acknowledged: 0,
      });
      orm.em.clear();
      expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
        amount: '18.00',
        currency: 'USD',
      });
      expect(await receiveQueueMessages()).toHaveLength(0);
    });
  });

  it('processes wagers, returns the original replay snapshot, and rejects divergent replays', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '100.00',
    });
    const bet = wagerInput(wallet, {
      externalTransactionId: crypto.randomUUID(),
      amount: '12.34',
    });
    const processed = await processWager.execute(bet);
    expect(processed.transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(processed.walletBalance).toEqual({
      amount: '87.66',
      currency: 'USD',
    });
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);

    await processWager.execute(wagerInput(wallet, { amount: '1.00' }));
    const replay = await processWager.execute(bet);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.walletBalance).toEqual({
      amount: '87.66',
      currency: 'USD',
    });

    await expect(
      processWager.execute({ ...bet, amount: '12.35' }),
    ).rejects.toMatchObject({
      failureCode: FailureCode.IDEMPOTENCY_CONFLICT,
    });
  });

  it('persists insufficient-funds rejection without changing wallet or ledger', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '0.00',
    });
    const result = await processWager.execute(
      wagerInput(wallet, { amount: '1.00' }),
    );
    expect(result.transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(result.walletBalance.amount).toBe('0.00');
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(0);
    expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
  });

  it('writes status and balance integration event envelopes to the outbox', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '0.00',
    });
    const roundId = crypto.randomUUID();
    const win = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.WIN,
        roundId,
        amount: '5.00',
        correlationId: 'integration-correlation',
        causationId: 'integration-causation',
      }),
    );
    await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.LOSS,
        roundId,
        amount: '1.00',
      }),
    );
    await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.BET,
        roundId,
        amount: '10.00',
      }),
    );
    await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.REFUND,
        roundId,
        amount: '5.00',
        referenceExternalTransactionId: crypto.randomUUID(),
      }),
    );

    const messages = (await outbox.findPending({ limit: 100 })).filter(
      ({ aggregateId }) => aggregateId === wallet.id,
    );
    const wagerEvents = messages.filter(({ eventType }) =>
      eventType.startsWith('WagerTransaction'),
    );
    const balanceEvents = messages.filter(
      ({ eventType }) => eventType === 'WalletBalanceChanged',
    );
    expect(wagerEvents.map(({ eventType }) => eventType).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
    ]);
    expect(balanceEvents).toHaveLength(1);
    const balancePayload = balanceEvents[0]?.payload;
    expect(balancePayload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      correlationId: 'integration-correlation',
      causationId: 'integration-causation',
      data: {
        money: { amount: '5.00', currency: 'USD' },
        walletVersion: 2,
      },
    });
    const occurredAt = balancePayload?.['occurredAt'];
    expect(typeof occurredAt).toBe('string');
    if (typeof occurredAt === 'string') {
      expect(occurredAt).toBe(new Date(occurredAt).toISOString());
    }
    expect(win.transaction.status).toBe(WagerTransactionStatus.PROCESSED);
  });

  it('keeps wallet balance equal to the ledger across mixed wager operations', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '100.00',
    });
    const roundId = crypto.randomUUID();
    const betId = crypto.randomUUID();
    const bet = await processWager.execute(
      wagerInput(wallet, {
        externalTransactionId: betId,
        roundId,
        amount: '20.00',
      }),
    );
    const win = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.WIN,
        referenceExternalTransactionId: betId,
        roundId,
        amount: '5.00',
      }),
    );
    const ledgerAfterWin = await ledger.findByWalletId(wallet.id);
    const loss = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.LOSS,
        roundId,
        amount: '3.00',
      }),
    );
    expect(loss.transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(
      ledgerAfterWin.length,
    );

    const refund = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.REFUND,
        referenceExternalTransactionId: betId,
        roundId,
        amount: '20.00',
      }),
    );
    const rollback = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.ROLLBACK,
        referenceExternalTransactionId: win.transaction.externalTransactionId,
        roundId,
        amount: '5.00',
      }),
    );
    expect([
      bet.transaction.status,
      win.transaction.status,
      refund.transaction.status,
      rollback.transaction.status,
    ]).toEqual(Array(4).fill(WagerTransactionStatus.PROCESSED));

    const entries = await ledger.findByWalletId(wallet.id);
    const credits = entries
      .filter(({ direction }) => direction === LedgerDirection.CREDIT)
      .reduce(
        (total, { money }) => total.add(money),
        Money.zero(wallet.currency),
      );
    const debits = entries
      .filter(({ direction }) => direction === LedgerDirection.DEBIT)
      .reduce(
        (total, { money }) => total.add(money),
        Money.zero(wallet.currency),
      );
    const persistedWallet = await wallets.findById(wallet.id);
    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    expect(credits.subtract(debits).toJSON()).toEqual(
      persistedWallet?.balance.toJSON(),
    );
    expect(persistedWallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'USD',
    });
  });

  it('holds out-of-order refunds pending and reprocesses after the referenced bet', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '100.00',
    });
    const roundId = crypto.randomUUID();
    const betId = crypto.randomUUID();
    const refund = await processWager.execute(
      wagerInput(wallet, {
        kind: WagerTransactionKind.REFUND,
        roundId,
        amount: '10.00',
        referenceExternalTransactionId: betId,
      }),
    );
    expect(refund.transaction.status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect(refund.walletBalance.amount).toBe('100.00');

    await processWager.execute(
      wagerInput(wallet, {
        externalTransactionId: betId,
        roundId,
        amount: '10.00',
      }),
    );
    const reprocessed = await processWager.reprocessPending(
      refund.transaction.id,
    );
    expect(reprocessed?.transaction.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(reprocessed?.walletBalance.amount).toBe('100.00');
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(3);
  });

  it('serializes concurrent bets on the same wallet with a pessimistic lock', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '10.00',
    });
    const results = await Promise.all([
      processWager.execute(
        wagerInput(wallet, { amount: '7.00', externalTransactionId: 'bet-a' }),
      ),
      processWager.execute(
        wagerInput(wallet, { amount: '7.00', externalTransactionId: 'bet-b' }),
      ),
    ]);
    expect(
      results.filter(
        ({ transaction }) =>
          transaction.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        ({ transaction }) =>
          transaction.status === WagerTransactionStatus.REJECTED,
      ),
    ).toHaveLength(1);
    expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
      amount: '3.00',
      currency: 'USD',
    });
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
  });

  it('resolves concurrent requests with the same idempotency key to one replay', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '20.00',
    });
    const input = wagerInput(wallet, {
      externalTransactionId: crypto.randomUUID(),
      amount: '5.00',
    });
    const results = await Promise.all([
      processWager.execute(input),
      processWager.execute(input),
    ]);
    expect(
      results
        .map(({ idempotentReplay }) => idempotentReplay)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(results[0]?.transaction.id).toBe(results[1]?.transaction.id);
    expect((await wallets.findById(wallet.id))?.balance.toJSON()).toEqual({
      amount: '15.00',
      currency: 'USD',
    });
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(2);
  });

  it('rolls back wallet, transaction and ledger if the outbox insert fails', async () => {
    const { wallet } = await createWallet.execute({
      playerId: crypto.randomUUID(),
      currency: 'USD',
      initialBalance: '10.00',
    });
    await adminClient.query(`
      create function "${schema}".reject_wager_outbox() returns trigger
      language plpgsql as $$
      begin
        if new.event_type = 'WagerTransactionProcessed' then
          raise exception 'forced outbox failure';
        end if;
        return new;
      end;
      $$;
      create trigger reject_wager_outbox
      before insert on "${schema}".outbox_messages
      for each row execute function "${schema}".reject_wager_outbox();
    `);
    const input = wagerInput(wallet, {
      externalTransactionId: crypto.randomUUID(),
      amount: '2.00',
    });
    try {
      await expect(processWager.execute(input)).rejects.toThrow(
        'forced outbox failure',
      );
    } finally {
      await adminClient.query(`
        drop trigger reject_wager_outbox on "${schema}".outbox_messages;
        drop function "${schema}".reject_wager_outbox();
      `);
    }

    const persistedWallet = await adminClient.query<{ balance: string }>(
      `select balance::text as balance
       from "${schema}".wallets where id = $1`,
      [wallet.id],
    );
    const persistedTransaction = await adminClient.query(
      `select 1 from "${schema}".wager_transactions
       where provider_id = $1 and external_transaction_id = $2`,
      [input.providerId, input.externalTransactionId],
    );
    const persistedLedger = await adminClient.query(
      `select 1 from "${schema}".wallet_ledger_entries where wallet_id = $1`,
      [wallet.id],
    );
    expect(persistedWallet.rows[0]?.balance).toBe('10.00');
    expect(persistedTransaction.rowCount).toBe(0);
    expect(persistedLedger.rowCount).toBe(1);
    orm.em.clear();
  });
});
