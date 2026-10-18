<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

For the application architecture, interview walkthrough, and step-by-step
manual testing instructions, see [teste-manual.md](./teste-manual.md).

## Project setup

```bash
$ bun install
```

## Compile and run the project

```bash
# development
$ bun run start

# watch mode
$ bun run start:dev

# production mode
$ bun run start:prod
```

## Production container

Build and run the production image with Bun:

```bash
docker build -t financial-service .
docker run --rm -p 3000:3000 \
  -e API_KEYS_JSON='["replace-with-a-secret"]' \
  -e PROVIDER_HMAC_SECRETS_JSON='{"provider-id":"replace-with-a-secret"}' \
  financial-service
```

The multi-stage Dockerfile installs dependencies from the committed `bun.lock`,
builds the NestJS application, then installs production dependencies into a
non-root Bun runtime image. GitHub Actions runs lint/type checking, unit,
PostgreSQL/LocalStack integration and E2E tests, and validates the production
image build on pushes and pull requests targeting `main` or `master`.

## Run tests

```bash
# unit tests
$ bun run test

# domain tests
$ bun test test/domain

# PostgreSQL persistence integration tests
$ docker compose up -d postgres-test localstack
$ bun test test/integration/persistence

# Real PostgreSQL + LocalStack HTTP E2E and concurrent-wallet tests
$ docker compose up -d postgres-test localstack
$ bun test --max-concurrency 1 test/e2e

# e2e tests
$ bun run test:e2e

# test coverage
$ bun run test:cov
```

## Financial transactions

`POST /transactions` accepts a transaction body and requires the
`Idempotency-Key: {providerId}:{externalTransactionId}` header. The service
persists the idempotency key, canonical payload hash, and final transaction
result on `financial_transactions`, with a unique database index enforcing
deduplication across concurrent requests. Identical replays return the
original transaction with `idempotentReplay: true`; divergent requests with
the same key return HTTP 409 and `IDEMPOTENCY_CONFLICT`. The payload hash is
SHA-256 over recursively key-sorted JSON containing only normalized business
fields; transport headers and extra request metadata are ignored. Transaction
state, wallet balance changes, and append-only ledger entries are committed
atomically in PostgreSQL. `REFUND` and `ROLLBACK` require a reference;
unresolved references are stored as `PENDING_REFERENCE` and can be retried
through `TransactionService.reprocessPending`.

Start PostgreSQL and apply the schema before processing transactions:

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres -d financial_db -f - < database/schema.sql
```

Wallet rows are provisioned by the wallet service or an operator. For local
testing, a wallet can be added with:

```sql
INSERT INTO wallets (id, currency, balance) VALUES ('wallet-1', 'USD', 100.00);
```

Set `DATABASE_URL` to override the default local connection string.

### MikroORM persistence schema

The aggregate persistence model is defined by the MikroORM entities in
`src/infrastructure/persistence/entities/`. Apply its versioned PostgreSQL
migration with:

```bash
docker compose up -d postgres
bun run migration:up
```

Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` to override
the MikroORM connection. `bun run migration:down` rolls back the latest
migration. Migration files are kept in
`src/infrastructure/persistence/migrations/`; do not synchronize the schema
with MikroORM's schema generator in deployed environments.

The application use cases are exposed by `FinancialUseCasesModule` in
`src/application/financial-use-cases.module.ts`. Import it only into a NestJS
application that already configures the default MikroORM connection and uses
the aggregate persistence schema. It exports `CreateWalletUseCase` and
`ProcessWagerTransactionUseCase`; the latter uses row locks, persistent
idempotency, and an atomic wallet/ledger/transaction/outbox transaction.

Integration events in `src/domain/events/` use a versioned JSON envelope with
event, aggregate, correlation, and causation identifiers. Event data is copied
and deeply frozen as JSON-compatible DTOs; monetary fields use `MoneyProps`
decimal strings. The wager use case writes processed/rejected/pending-reference
events and emits `WalletBalanceChanged` only when it writes a ledger entry.

The wager Inbox consumer is exposed by
`WagerTransactionConsumerModule.registerSqs(...)` in
`src/infrastructure/messaging/wager-transaction-consumer.module.ts`. Configure
a stable `consumerName`; in local environments the module provisions
`wager-transactions.fifo` and `wager-transactions-dlq.fifo` automatically.
Messages contain the wager business fields accepted by
`ProcessWagerTransactionUseCase`; an integration-event envelope with those
fields under `data` is also accepted. The consumer persists the SQS `MessageId`
and payload hash, processes the wager, and marks the Inbox row processed in one
PostgreSQL transaction. It deletes the SQS message only after that transaction
commits. Failed processing leaves the message visible for redelivery; a
redelivery with an already-processed Inbox key is acknowledged without
repeating financial effects.

Malformed payloads and permanent domain rejections are logged with a stable
failure code, recorded as processed in the Inbox when possible, and
acknowledged. Infrastructure/unknown errors are logged as transient and left
unacknowledged so SQS can redeliver them. The main FIFO queue's redrive policy
moves repeatedly failing messages to `wager-transactions-dlq.fifo` after the
configured `maxReceiveCount` (five by default).

The NestJS bootstrap enables `SIGTERM` and `SIGINT` shutdown hooks. Both the
Inbox consumer and Outbox publisher stop scheduling polls, drain active work,
then close their SQS clients; the Outbox publisher is closed only after its
active database transaction finishes. `shutdownTimeoutMs` (30 seconds by
default) emits a warning if draining is slow; the workers continue waiting
rather than closing the database connection underneath an active transaction.

The transactional outbox worker is exposed by
`OutboxProcessingModule.registerSqs(...)` in
`src/infrastructure/messaging/outbox-processing.module.ts`. Configure explicit
`queueUrls` for integration-event destinations (per event type or `'*'` as a
fallback); do not route the Outbox back to the inbound wager queue. The SQS
client uses `SQS_ENDPOINT` or `AWS_ENDPOINT_URL` when configured; in
non-production environments it defaults to LocalStack at
`http://localhost:4566`, with the `test` access key and secret unless AWS
credentials are provided. For an application running in Docker Compose, set
`SQS_ENDPOINT=http://localstack:4566`; for a host process, use
`http://localhost:4566`.

The outbox worker claims rows in a batch transaction using PostgreSQL
`FOR UPDATE SKIP LOCKED`, publishes to SQS while retaining those locks, and
marks successful sends or schedules exponential retries before commit. Events
committed with a financial transaction are visible to the worker only after
that transaction commits.

The `bun test test/integration/messaging/sqs-localstack.test.ts` integration
test provisions isolated FIFO/DLQ queues, verifies their attributes and
redrive policy, then sends and receives a message. Start LocalStack first with
`docker compose up -d localstack`.
The PostgreSQL/LocalStack consumer redelivery tests run with
`bun test test/integration/persistence/postgres-persistence.test.ts`; start
both services with `docker compose up -d postgres-test localstack`.

Delivery is at-least-once: a process crash after SQS accepts a message but
before PostgreSQL records `published_at` can cause a later resend. Consumers
must deduplicate by the envelope `eventId` (the Inbox pattern); concurrent
publishers will not claim the same locked outbox row.

The current HTTP transaction adapter still uses the earlier flat SQL schema
above. Its `wallets` table shape is incompatible with the aggregate schema, so
do not apply both schemas to the same PostgreSQL schema; switching the runtime
adapter to MikroORM is a separate integration step.

### Aggregate REST API

`FinancialPresentationModule` in `src/presentation/presentation.module.ts`
exposes the aggregate use cases through NestJS controllers. Import it into an
application that has configured the default MikroORM connection and applied
the aggregate persistence migrations:

```ts
@Module({
  imports: [
    MikroOrmModule.forRoot(financialOrmConfig),
    FinancialPresentationModule,
  ],
})
export class ApiModule {}
```

The module adds:

- `POST /wallets` to create a wallet (initial balance defaults to `0.00`);
- `GET /wallets/:id` to retrieve wallet balance and version;
- `GET /wallets/:id/ledger?limit=50&cursor=<entry-id>` for cursor-paginated
  immutable ledger entries;
- `POST /wagers/transactions` to process `BET`, `WIN`, `LOSS`, `REFUND` or
  `ROLLBACK`.

DTO pipes reject unknown fields, malformed decimal strings and invalid ISO
4217 currencies. The wager endpoint requires
`Idempotency-Key: {providerId}:{externalTransactionId}`. Processed requests
and idempotent replays return HTTP 200, pending references return HTTP 202,
business-rule rejections return HTTP 422, and idempotency conflicts return
HTTP 409.

All `/wallets`, `/wagers`, and provider `/transactions` routes require
`X-API-Key` or an equivalent `Authorization: Bearer` token configured in the JSON string array
`API_KEYS_JSON`. `POST /wagers/transactions` additionally requires
`X-Signature` or `X-Hub-Signature`, containing the hex HMAC-SHA-256 of the
exact raw request body (an optional `sha256=` prefix is accepted). The
provider secret is selected by the body `providerId` from
`PROVIDER_HMAC_SECRETS_JSON`, a JSON object mapping provider IDs to shared
secrets. Both provider transaction endpoints require that signature.
Configure both environment variables from a secret manager in each
environment; requests fail closed if authentication configuration is absent.
The NestJS HTTP bootstrap enables raw-body capture for signature validation.

`GlobalExceptionFilter` is registered as an `APP_FILTER` in the root
`AppModule`. It normalizes domain, Nest HTTP, MikroORM constraint, and
unexpected exceptions into `{ statusCode, errorCode, message, timestamp,
path }`. Financial rule failures return 422, idempotency/resource conflicts
409, missing resources 404, and invalid input 400. Unexpected failures return
a generic 500 message; structured internal logs include the exception chain
and a propagated `x-correlation-id` (or request correlation id), without
returning stack traces or database details to clients.

The starter `AppModule` continues to serve the earlier flat-schema adapter;
do not import the aggregate presentation module there until its runtime is
configured against the separate MikroORM aggregate schema. This avoids
collisions between the legacy and aggregate `wallets` table layouts.

## Pure domain

Framework-independent domain types live under `src/domain/`: `Money` uses
`decimal.js` with two fractional digits, `Wallet` guards balance invariants,
`WagerTransaction` owns its state machine, and `WalletLedgerEntry` validates
balance consistency. They can be tested separately with `bun test test/domain`.

Wager domain processing validates transaction references and their provider,
player, wallet, currency, round, status, and amount before applying a balance
movement. Missing or still-pending references remain `PENDING_REFERENCE`;
successful balance movements return a validated immutable ledger entry, while
`LOSS` completes without moving funds. An unaffordable `BET` is rejected with
`INSUFFICIENT_FUNDS`; `NEGATIVE_BALANCE_PREVENTED` identifies other debits that
would make a wallet negative. Domain failure codes also include
`TRANSACTION_NOT_FOUND`, `DUPLICATE_REFERENCE`, `ALREADY_PROCESSED`, and the
reference, currency, payload, and state codes. The complete stable code set is
`INSUFFICIENT_BALANCE`, `INSUFFICIENT_FUNDS`, `TRANSACTION_NOT_FOUND`,
`DUPLICATE_REFERENCE`, `ALREADY_PROCESSED`, `NEGATIVE_BALANCE_PREVENTED`,
`REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_REVERSIBLE`,
`DUPLICATE_REFERENCE_REVERSAL`, `INVALID_CURRENCY`, `INVALID_PAYLOAD`,
`INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_CONFLICT`,
`INVALID_TRANSACTION_STATE`, `WALLET_NOT_FOUND`,
`BALANCE_LIMIT_EXCEEDED`, `INVALID_MONEY`, `INVALID_WALLET_BALANCE`, and
`INVALID_LEDGER_ENTRY`.

Persistence integration tests connect to the dedicated `postgres-test` Compose
service on port `5433` and use a unique PostgreSQL schema per run. They execute
the real MikroORM migrations and drop their schema during teardown. Override
the connection with `DB_TEST_HOST`, `DB_TEST_PORT`, `DB_TEST_USER`,
`DB_TEST_PASSWORD`, and `DB_TEST_NAME` if needed; the tests never use the
application database by default.

The HTTP E2E suite in `test/e2e/financial-service.e2e.test.ts` boots the
NestJS presentation, Outbox, and Inbox modules against a uniquely migrated
PostgreSQL schema and temporary FIFO queues in LocalStack. It exercises all
wager kinds, wallet and ledger reads, idempotency replay/conflict, insufficient
funds, event publication, Inbox deduplication, and HTTP throttling. It also
sends concurrent HTTP bets to verify the persisted wallet and ledger
invariants. The suite requires the `postgres-test` and `localstack` Compose
services; serial Bun test execution avoids resource contention with other
database/messaging suites.

The presentation module applies in-memory fixed-window rate limits before
authentication guards: `POST /wagers/transactions` allows 30 requests per
minute per provider/player/client IP, while wallet endpoints allow 120
requests per minute per API credential/client IP. Rejections return HTTP 429
with the standard error envelope and `Retry-After`,
`X-RateLimit-Limit`, and `X-RateLimit-Remaining` headers. Buckets are
process-local and are not shared across application replicas.

Wallet reconciliation runs hourly from `WalletReconciliationModule`. Each
pass keyset-pages wallets in batches of 500 and compares the stored balance
with the exact PostgreSQL `NUMERIC` sum of immutable credits and debits; it
does not load ledger rows into application memory or mutate financial data.
Discrepancies are logged at critical severity and increment
`financial_reconciliation_discrepancies_total`. The
`WalletReconciliationService` can also be invoked directly for operational
audits and controlled verification.

The financial presentation module exposes `GET /health/live`,
`GET /health/ready`, and `GET /metrics`. Liveness reports the running process;
readiness executes `SELECT 1` against PostgreSQL and calls SQS `ListQueues`
with a two-second timeout. Prometheus output includes wager outcome counters,
processing-duration histograms, domain-failure counters, and live Outbox and
Inbox backlog gauges. The production SQS role needs `sqs:ListQueues` for the
readiness probe.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ bun install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

The HTTP application captures a valid `X-Correlation-ID` or generates a UUID
v4, returns it in the response header, and keeps it in native
`AsyncLocalStorage`. The application logger emits JSON records with
`level`, `timestamp`, `correlationId`, `aggregateId`, `duration`, and
`context`. Wager events use the active correlation ID in the transactional
Outbox; the Outbox publisher includes it as an SQS message attribute, and the
Inbox consumer restores it before processing and persists it in
`inbox_messages.correlation_id`. The additive
`Migration20261018130000_AddInboxCorrelationId` migration adds that Inbox
column while leaving older rows valid.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. Create a free account at [observe.nestjs.com](https://observe.nestjs.com), add an application, and paste the generated app key and secret into the `ObserveModule.forRoot()` call in `src/app.module.ts`.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
