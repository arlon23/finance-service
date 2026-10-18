import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { FinancialPresentationModule } from '../../src/presentation/presentation.module.js';
import { GlobalExceptionFilter } from '../../src/presentation/filters/global-exception.filter.js';
import { CorrelationMiddleware } from '../../src/infrastructure/logging/correlation.middleware.js';
import { OutboxProcessingModule } from '../../src/infrastructure/messaging/outbox-processing.module.js';
import { WagerTransactionConsumerModule } from '../../src/infrastructure/messaging/wager-transaction-consumer.module.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.provider.js';
import { SqsSetupService } from '../../src/infrastructure/messaging/sqs-setup.service.js';
import { OutboxProcessor } from '../../src/application/workers/outbox-processor.js';
import { WagerTransactionConsumer } from '../../src/application/workers/wager-transaction-consumer.js';
import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../src/infrastructure/persistence/entities/outbox-message.entity.js';
import { InboxMessageEntity } from '../../src/infrastructure/persistence/entities/inbox-message.entity.js';
import { Migration20261016190456_CreateFinancialPersistence } from '../../src/infrastructure/persistence/migrations/Migration20261016190456_CreateFinancialPersistence.js';
import { Migration20261016190500_AddWagerTransactionUpdatedAt } from '../../src/infrastructure/persistence/migrations/Migration20261016190500_AddWagerTransactionUpdatedAt.js';
import { Migration20261017085000_AddWagerTransactionResultingBalance } from '../../src/infrastructure/persistence/migrations/Migration20261017085000_AddWagerTransactionResultingBalance.js';
import { Migration20261017181500_OptimizeOutboxPendingLookup } from '../../src/infrastructure/persistence/migrations/Migration20261017181500_OptimizeOutboxPendingLookup.js';
import { Migration20261018130000_AddInboxCorrelationId } from '../../src/infrastructure/persistence/migrations/Migration20261018130000_AddInboxCorrelationId.js';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction.js';
import { WalletReconciliationService } from '../../src/application/services/wallet-reconciliation.service.js';

const database = {
  host: process.env.DB_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_TEST_PORT ?? '5433'),
  user: process.env.DB_TEST_USER ?? 'postgres',
  password: process.env.DB_TEST_PASSWORD ?? 'postgres',
  dbName: process.env.DB_TEST_NAME ?? 'financial_test_db',
};
const sqsEndpoint = process.env.SQS_TEST_ENDPOINT ?? 'http://127.0.0.1:4566';
const schema = `financial_e2e_${crypto.randomUUID().replaceAll('-', '')}`;
const queueSuffix = crypto.randomUUID();
const wagerQueueName = `financial-e2e-wagers-${queueSuffix}.fifo`;
const wagerDlqName = `financial-e2e-wagers-dlq-${queueSuffix}.fifo`;
const eventQueueName = `financial-e2e-events-${queueSuffix}.fifo`;
const migrations = [
  Migration20261016190456_CreateFinancialPersistence,
  Migration20261016190500_AddWagerTransactionUpdatedAt,
  Migration20261017085000_AddWagerTransactionResultingBalance,
  Migration20261017181500_OptimizeOutboxPendingLookup,
  Migration20261018130000_AddInboxCorrelationId,
];
const testApiKey = 'financial-e2e-api-key';
const testProviderSecret = 'financial-e2e-provider-secret';
const originalApiKeys = process.env.API_KEYS_JSON;
const originalProviderSecrets = process.env.PROVIDER_HMAC_SECRETS_JSON;

let adminClient: Client;
let sqs: SQSClient;
let app: INestApplication<App>;
let wagerQueueUrl: string;
let wagerDlqUrl: string;
let eventQueueUrl: string;
let outboxProcessor: OutboxProcessor;
let wagerConsumer: WagerTransactionConsumer;

function createE2eRootModule() {
  class FinancialE2eModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(CorrelationMiddleware).forRoutes('*');
    }
  }

  Module({
    imports: [
      MikroOrmModule.forRoot({
        driver: PostgreSqlDriver,
        contextName: 'default',
        ...database,
        schema,
        registerRequestContext: false,
        entities: [
          WalletEntity,
          WagerTransactionEntity,
          WalletLedgerEntryEntity,
          OutboxMessageEntity,
          InboxMessageEntity,
        ],
        allowGlobalContext: true,
      }),
      FinancialPresentationModule,
      OutboxProcessingModule.registerSqs({
        queueUrls: { '*': eventQueueUrl },
        processor: {
          pollIntervalMs: 3_600_000,
          shutdownTimeoutMs: 30_000,
        },
        endpoint: sqsEndpoint,
      }),
      WagerTransactionConsumerModule.registerSqs({
        consumerName: 'financial-e2e-wager-consumer',
        queueUrl: wagerQueueUrl,
        endpoint: sqsEndpoint,
        processor: {
          pollIntervalMs: 3_600_000,
          waitTimeSeconds: 0,
          visibilityTimeoutSeconds: 0,
        },
      }),
    ],
    providers: [
      CorrelationMiddleware,
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ],
  })(FinancialE2eModule);

  return FinancialE2eModule;
}

interface WalletResponse {
  id: string;
  playerId: string;
  currency: string;
  balance: { amount: string; currency: string };
}

interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

function wager(
  wallet: WalletResponse,
  kind: WagerTransactionKind,
  amount: string,
  externalTransactionId: string,
  roundId: string,
  referenceExternalTransactionId?: string,
): WagerPayload {
  return {
    providerId: 'e2e-provider',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'e2e-game',
    kind,
    amount,
    currency: wallet.currency,
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  };
}

function postWager(payload: WagerPayload, idempotencyKey?: string) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', testProviderSecret)
    .update(body)
    .digest('hex');
  return request(app.getHttpServer())
    .post('/wagers/transactions')
    .set('X-API-Key', testApiKey)
    .set('X-Signature', signature)
    .set('Content-Type', 'application/json')
    .set(
      'Idempotency-Key',
      idempotencyKey ??
        `${payload.providerId}:${payload.externalTransactionId}`,
    )
    .send(body);
}

async function provisionQueue(queueName: string): Promise<string> {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
      },
    }),
  );
  if (!response.QueueUrl) {
    throw new Error(`LocalStack did not provision ${queueName}`);
  }
  return response.QueueUrl;
}

beforeAll(async () => {
  process.env.API_KEYS_JSON = JSON.stringify([testApiKey]);
  process.env.PROVIDER_HMAC_SECRETS_JSON = JSON.stringify({
    'e2e-provider': testProviderSecret,
  });
  adminClient = new Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.dbName,
  });
  await adminClient.connect();
  await adminClient.query(`create schema "${schema}"`);

  const migrationOrm = await MikroORM.init({
    driver: PostgreSqlDriver,
    ...database,
    schema,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      OutboxMessageEntity,
      InboxMessageEntity,
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
  await migrationOrm.migrator.up({ schema });
  await migrationOrm.close(true);

  sqs = createSqsClient(
    { endpoint: sqsEndpoint, region: 'us-east-1' },
    { NODE_ENV: 'test' },
  );
  const wagerQueues = await new SqsSetupService(sqs, {
    queueName: wagerQueueName,
    deadLetterQueueName: wagerDlqName,
  }).ensureWagerQueues();
  wagerQueueUrl = wagerQueues.queueUrl;
  wagerDlqUrl = wagerQueues.deadLetterQueueUrl;
  eventQueueUrl = await provisionQueue(eventQueueName);

  const moduleFixture = await Test.createTestingModule({
    imports: [createE2eRootModule()],
  }).compile();
  app = moduleFixture.createNestApplication({ rawBody: true });
  await app.init();
  outboxProcessor = app.get(OutboxProcessor);
  wagerConsumer = app.get(WagerTransactionConsumer);
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
  if (sqs) {
    for (const queueUrl of [wagerQueueUrl, wagerDlqUrl, eventQueueUrl]) {
      if (queueUrl) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    }
    sqs.destroy();
  }
  if (adminClient) {
    await adminClient.query(`drop schema if exists "${schema}" cascade`);
    await adminClient.end();
  }
  if (originalApiKeys === undefined) {
    delete process.env.API_KEYS_JSON;
  } else {
    process.env.API_KEYS_JSON = originalApiKeys;
  }
  if (originalProviderSecrets === undefined) {
    delete process.env.PROVIDER_HMAC_SECRETS_JSON;
  } else {
    process.env.PROVIDER_HMAC_SECRETS_JSON = originalProviderSecrets;
  }
});

describe('financial service real-infrastructure E2E', () => {
  it('reconciles wallet balances against ledger sums and increments discrepancy metrics', async () => {
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .set('X-API-Key', testApiKey)
      .send({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '15.99',
      })
      .expect(201);
    const wallet = walletResponse.body as WalletResponse;
    const reconciliation = app.get(WalletReconciliationService);

    const consistent = await reconciliation.reconcile(1);
    expect(consistent.auditedWallets).toBe(1);
    expect(consistent.discrepancies).toEqual([]);

    await adminClient.query(
      `update "${schema}"."wallets" set balance = '16.00' where id = $1`,
      [wallet.id],
    );
    const inconsistent = await reconciliation.reconcile(1);
    expect(inconsistent.auditedWallets).toBe(1);
    expect(inconsistent.discrepancies).toEqual([
      {
        walletId: wallet.id,
        walletBalance: '16.00',
        ledgerBalance: '15.99',
      },
    ]);

    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.text).toMatch(
      /financial_reconciliation_discrepancies_total 1/,
    );
  });

  it('exposes liveness, readiness, and Prometheus financial metrics', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });

    const readiness = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(readiness.body.status).toBe('ok');
    expect(readiness.body.info).toMatchObject({
      database: { status: 'up' },
      sqs: { status: 'up' },
    });

    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.headers['content-type']).toContain('version=0.0.4');
    expect(metrics.text).toContain(
      '# HELP wager_transactions_total Financial wager transactions by kind and processing outcome.',
    );
    expect(metrics.text).toContain(
      '# TYPE wager_processing_duration_seconds histogram',
    );
    expect(metrics.text).toContain('outbox_pending_messages');
    expect(metrics.text).toContain('inbox_pending_messages');
  });

  it('rejects missing API keys and invalid or missing provider signatures', async () => {
    await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}`)
      .expect(401);

    const payload = {
      providerId: 'e2e-provider',
      externalTransactionId: crypto.randomUUID(),
    };
    await request(app.getHttpServer())
      .post('/wagers/transactions')
      .set('X-API-Key', testApiKey)
      .set(
        'Idempotency-Key',
        `${payload.providerId}:${payload.externalTransactionId}`,
      )
      .send(payload)
      .expect(401);

    await request(app.getHttpServer())
      .post('/wagers/transactions')
      .set('X-API-Key', testApiKey)
      .set('X-Signature', '0'.repeat(64))
      .set(
        'Idempotency-Key',
        `${payload.providerId}:${payload.externalTransactionId}`,
      )
      .send(payload)
      .expect(401);

    await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(404);
  });

  it('returns the standard 429 envelope and rate-limit headers for wager bursts', async () => {
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .set('X-API-Key', testApiKey)
      .send({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '100.00',
      })
      .expect(201);
    const wallet = walletResponse.body as WalletResponse;
    const payload = wager(
      wallet,
      WagerTransactionKind.BET,
      '1.00',
      crypto.randomUUID(),
      crypto.randomUUID(),
    );

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await postWager(payload).expect(200);
      expect(response.headers['x-ratelimit-limit']).toBe('30');
    }

    const limitedResponse = await postWager(payload).expect(429);
    expect(limitedResponse.body).toMatchObject({
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
    });
    expect(limitedResponse.headers['x-ratelimit-limit']).toBe('30');
    expect(limitedResponse.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(limitedResponse.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('completes wallet, wager, replay, Outbox/SQS and Inbox processing', async () => {
    const correlationId = `http-e2e-${crypto.randomUUID()}`;
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .set('X-API-Key', testApiKey)
      .set('X-Correlation-ID', correlationId)
      .send({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '100.00',
      })
      .expect(201)
      .expect('X-Correlation-ID', correlationId);
    const wallet = walletResponse.body as WalletResponse;
    expect(wallet.balance).toEqual({ amount: '100.00', currency: 'USD' });

    const roundId = crypto.randomUUID();
    const bet = wager(
      wallet,
      WagerTransactionKind.BET,
      '20.00',
      crypto.randomUUID(),
      roundId,
    );
    const betKey = `${bet.providerId}:${bet.externalTransactionId}`;
    const betResponse = await postWager(bet, betKey).expect(200);
    expect(betResponse.body).toMatchObject({
      transaction: { kind: 'BET', status: 'PROCESSED' },
      walletBalance: { amount: '80.00', currency: 'USD' },
      idempotentReplay: false,
    });
    expect((await postWager(bet, betKey).expect(200)).body).toMatchObject({
      idempotentReplay: true,
      walletBalance: { amount: '80.00', currency: 'USD' },
    });
    expect(
      (await postWager({ ...bet, amount: '21.00' }, betKey).expect(409)).body,
    ).toMatchObject({ errorCode: 'IDEMPOTENCY_CONFLICT' });

    const win = wager(
      wallet,
      WagerTransactionKind.WIN,
      '5.00',
      crypto.randomUUID(),
      roundId,
      bet.externalTransactionId,
    );
    await postWager(win).expect(200);
    const loss = wager(
      wallet,
      WagerTransactionKind.LOSS,
      '1.00',
      crypto.randomUUID(),
      roundId,
    );
    await postWager(loss).expect(200);
    const refund = wager(
      wallet,
      WagerTransactionKind.REFUND,
      '20.00',
      crypto.randomUUID(),
      roundId,
      bet.externalTransactionId,
    );
    await postWager(refund).expect(200);
    const rollback = wager(
      wallet,
      WagerTransactionKind.ROLLBACK,
      '5.00',
      crypto.randomUUID(),
      roundId,
      win.externalTransactionId,
    );
    await postWager(rollback).expect(200);

    const failedBet = wager(
      wallet,
      WagerTransactionKind.BET,
      '1000.00',
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
    expect((await postWager(failedBet).expect(422)).body).toMatchObject({
      transaction: {
        failureCode: 'INSUFFICIENT_FUNDS',
        status: 'REJECTED',
      },
    });
    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.text).toMatch(
      /wager_transactions_total\{kind="BET",status="SUCCESS"\} [1-9]\d*/,
    );
    expect(metrics.text).toMatch(
      /wager_transactions_total\{kind="BET",status="REJECTED"\} [1-9]\d*/,
    );
    expect(metrics.text).toMatch(
      /financial_business_failures_total\{failure_code="INSUFFICIENT_FUNDS"\} [1-9]\d*/,
    );
    expect(metrics.text).toContain('wager_processing_duration_seconds_bucket');

    const finalWallet = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .set('X-API-Key', testApiKey)
      .expect(200);
    expect(finalWallet.body.balance).toEqual({
      amount: '100.00',
      currency: 'USD',
    });

    const ledgerResponse = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger`)
      .set('X-API-Key', testApiKey)
      .expect(200);
    const ledgerEntries = ledgerResponse.body.entries as Array<{
      direction: 'CREDIT' | 'DEBIT';
      money: { amount: string; currency: string };
      balanceAfter: { amount: string; currency: string };
    }>;
    const ledgerTotalMinor = ledgerEntries.reduce((total, entry) => {
      const amount = Math.round(Number(entry.money.amount) * 100);
      return total + (entry.direction === 'CREDIT' ? amount : -amount);
    }, 0);
    expect(ledgerTotalMinor).toBe(10_000);
    expect(ledgerEntries.at(-1)?.balanceAfter).toEqual({
      amount: '100.00',
      currency: 'USD',
    });

    const outboxCount = await adminClient.query<{ count: string }>(
      `select count(*) from "${schema}"."outbox_messages"`,
    );
    expect(Number(outboxCount.rows[0]?.count)).toBeGreaterThan(0);
    const published = await outboxProcessor.processBatch();
    expect(published.published).toBeGreaterThan(0);
    const publishedEvents = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
      }),
    );
    expect(publishedEvents.Messages?.length).toBeGreaterThan(0);
    const correlatedEvent = publishedEvents.Messages?.find(
      (message) =>
        message.MessageAttributes?.correlationId?.StringValue === correlationId,
    );
    expect(correlatedEvent).toBeDefined();

    const inboxCorrelationId = `inbox-e2e-${crypto.randomUUID()}`;
    const queuedWager = wager(
      wallet,
      WagerTransactionKind.BET,
      '3.00',
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: wagerQueueUrl,
        MessageBody: JSON.stringify(queuedWager),
        MessageGroupId: queuedWager.walletId,
        MessageAttributes: {
          correlationId: {
            DataType: 'String',
            StringValue: inboxCorrelationId,
          },
        },
      }),
    );
    const delivery = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: wagerQueueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 0,
        MessageAttributeNames: ['All'],
      }),
    );
    const message = delivery.Messages?.[0];
    if (!message?.MessageId || !message.ReceiptHandle) {
      throw new Error('LocalStack did not return the E2E wager delivery');
    }
    await wagerConsumer.processMessage(message);
    await wagerConsumer.processMessage(message);
    const inboxRow = await adminClient.query<{
      correlation_id: string;
      processed_at: Date | null;
    }>(
      `select "correlation_id", "processed_at"
       from "${schema}"."inbox_messages"
       where "consumer_name" = $1 and "message_id" = $2`,
      ['financial-e2e-wager-consumer', message.MessageId],
    );
    expect(inboxRow.rows).toEqual([
      {
        correlation_id: inboxCorrelationId,
        processed_at: expect.any(Date),
      },
    ]);
    const afterInbox = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .set('X-API-Key', testApiKey)
      .expect(200);
    expect(afterInbox.body.balance).toEqual({
      amount: '97.00',
      currency: 'USD',
    });
    const wagerCount = await adminClient.query<{ count: string }>(
      `select count(*) from "${schema}"."wager_transactions"
       where "external_transaction_id" = $1`,
      [queuedWager.externalTransactionId],
    );
    expect(Number(wagerCount.rows[0]?.count)).toBe(1);
  });

  it('serializes concurrent HTTP bets without lost updates', async () => {
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .set('X-API-Key', testApiKey)
      .send({
        playerId: crypto.randomUUID(),
        currency: 'USD',
        initialBalance: '10.00',
      })
      .expect(201);
    const wallet = walletResponse.body as WalletResponse;
    const wagers = Array.from({ length: 20 }, () =>
      wager(
        wallet,
        WagerTransactionKind.BET,
        '1.00',
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    );
    const responses = await Promise.all(
      wagers.map((payload) => postWager(payload)),
    );

    expect(responses.filter(({ status }) => status === 200)).toHaveLength(10);
    expect(responses.filter(({ status }) => status === 422)).toHaveLength(10);
    expect(
      responses
        .filter(({ status }) => status === 422)
        .every(
          ({ body }) =>
            body.transaction.failureCode === 'INSUFFICIENT_FUNDS' &&
            body.transaction.status === 'REJECTED',
        ),
    ).toBe(true);

    const finalWallet = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .set('X-API-Key', testApiKey)
      .expect(200);
    expect(finalWallet.body.balance).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
    const entries = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=100`)
      .set('X-API-Key', testApiKey)
      .expect(200);
    const ledgerEntries = entries.body.entries as Array<{
      direction: 'CREDIT' | 'DEBIT';
      money: { amount: string };
      balanceAfter: { amount: string };
    }>;
    const netMinor = ledgerEntries.reduce((total, entry) => {
      const amount = Math.round(Number(entry.money.amount) * 100);
      return total + (entry.direction === 'CREDIT' ? amount : -amount);
    }, 0);
    expect(netMinor).toBe(0);
    expect(ledgerEntries).toHaveLength(11);
    expect(ledgerEntries[0]?.balanceAfter.amount).toBe('0.00');

    const persistedCounts = await adminClient.query<{
      accepted: string;
      rejected: string;
      ledger_entries: string;
    }>(
      `select
         count(*) filter (where kind = 'BET' and status = 'PROCESSED')::text as accepted,
         count(*) filter (where status = 'REJECTED')::text as rejected,
         (select count(*)::text from "${schema}"."wallet_ledger_entries"
          where wallet_id = $1) as ledger_entries
       from "${schema}"."wager_transactions"
       where wallet_id = $1`,
      [wallet.id],
    );
    expect(persistedCounts.rows[0]).toEqual({
      accepted: '10',
      rejected: '10',
      ledger_entries: '11',
    });
  });
});
