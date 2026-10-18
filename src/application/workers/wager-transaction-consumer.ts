import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { createHash, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import type { InboxRepositoryPort } from '../ports/financial-persistence.js';
import {
  INBOX_REPOSITORY,
  WAGER_CONSUMER_OPTIONS,
  WAGER_CONSUMER_SQS_CLIENT,
} from '../tokens.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { calculateWagerPayloadHash } from '../payload-hash.js';
import { DomainError } from '../../domain/domain-error.js';
import { FailureCode } from '../../domain/failure-code.js';
import { waitForGracefulDrain } from './graceful-drain.js';
import { correlationContext } from '../../infrastructure/logging/correlation-context.js';
import { FinancialMetricsService } from '../../infrastructure/metrics/financial-metrics.service.js';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';

export interface WagerTransactionConsumerOptions {
  consumerName: string;
  queueUrl: string;
  pollIntervalMs: number;
  batchSize: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_WAGER_TRANSACTION_CONSUMER_OPTIONS: Omit<
  WagerTransactionConsumerOptions,
  'consumerName' | 'queueUrl'
> = {
  pollIntervalMs: 1_000,
  batchSize: 10,
  waitTimeSeconds: 10,
  visibilityTimeoutSeconds: 30,
  shutdownTimeoutMs: 30_000,
};

const TERMINAL_FAILURE_CODES = new Set<FailureCode>([
  FailureCode.INSUFFICIENT_BALANCE,
  FailureCode.INSUFFICIENT_FUNDS,
  FailureCode.DUPLICATE_REFERENCE,
  FailureCode.ALREADY_PROCESSED,
  FailureCode.NEGATIVE_BALANCE_PREVENTED,
  FailureCode.REFERENCE_MISMATCH,
  FailureCode.REFERENCE_NOT_REVERSIBLE,
  FailureCode.DUPLICATE_REFERENCE_REVERSAL,
  FailureCode.INVALID_CURRENCY,
  FailureCode.INVALID_PAYLOAD,
  FailureCode.INVALID_IDEMPOTENCY_KEY,
  FailureCode.IDEMPOTENCY_CONFLICT,
  FailureCode.INVALID_TRANSACTION_STATE,
  FailureCode.WALLET_NOT_FOUND,
  FailureCode.INVALID_MONEY,
  FailureCode.INVALID_WALLET_BALANCE,
  FailureCode.WALLET_ALREADY_EXISTS,
  FailureCode.INVALID_LEDGER_ENTRY,
]);

export type WagerConsumerFailureCategory = 'terminal' | 'transient';

export function classifyWagerConsumerError(
  error: unknown,
): WagerConsumerFailureCategory {
  return error instanceof DomainError &&
    TERMINAL_FAILURE_CODES.has(error.failureCode)
    ? 'terminal'
    : 'transient';
}

interface ParsedWagerMessage {
  input: ProcessWagerTransactionInput;
  idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isWagerKind(value: unknown): value is WagerTransactionKind {
  return Object.values(WagerTransactionKind).some((kind) => kind === value);
}

function parseWagerMessage(body: string): ParsedWagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      `SQS wager message body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'SQS wager message must contain a JSON object',
    );
  }
  const data = isRecord(parsed.data) ? parsed.data : parsed;
  const money = isRecord(data.money) ? data.money : undefined;
  const amount = data.amount ?? money?.amount;
  const currency = data.currency ?? money?.currency;
  if (
    !isString(data.providerId) ||
    !isString(data.externalTransactionId) ||
    !isString(data.playerId) ||
    !isString(data.walletId) ||
    !isString(data.roundId) ||
    !isString(data.gameId) ||
    !isString(amount) ||
    !isString(currency) ||
    !isWagerKind(data.kind)
  ) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'SQS wager message is missing required business fields',
    );
  }

  const optionalFields = [
    data.referenceExternalTransactionId,
    data.idempotencyKey,
    parsed.correlationId,
    parsed.causationId,
  ];
  if (optionalFields.some((field) => field !== undefined && !isString(field))) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'SQS wager message contains invalid optional fields',
    );
  }
  const idempotencyKey = isString(data.idempotencyKey)
    ? data.idempotencyKey
    : `${data.providerId}:${data.externalTransactionId}`;
  const input: ProcessWagerTransactionInput = {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    amount,
    currency,
    ...(isString(data.referenceExternalTransactionId)
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
      : {}),
    ...(isString(data.idempotencyKey)
      ? { idempotencyKey: data.idempotencyKey }
      : {}),
    ...(isString(parsed.correlationId)
      ? { correlationId: parsed.correlationId }
      : {}),
    ...(isString(parsed.causationId)
      ? { causationId: parsed.causationId }
      : {}),
  };
  return { input, idempotencyKey };
}

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private timer?: ReturnType<typeof setInterval>;
  private activePoll?: Promise<void>;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private acceptingMessages = true;

  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepositoryPort,
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WAGER_CONSUMER_SQS_CLIENT) private readonly client: SQSClient,
    @Inject(WAGER_CONSUMER_OPTIONS)
    private readonly options: WagerTransactionConsumerOptions,
    @Optional()
    private readonly metrics?: FinancialMetricsService,
  ) {
    this.validateOptions(options);
  }

  onModuleInit(): void {
    this.acceptingMessages = true;
    this.timer = setInterval(
      () => this.runScheduledPoll(),
      this.options.pollIntervalMs,
    );
    this.timer.unref?.();
    this.runScheduledPoll();
  }

  async onModuleDestroy(): Promise<void> {
    this.acceptingMessages = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await waitForGracefulDrain(
      [...this.activeOperations],
      this.options.shutdownTimeoutMs,
      this.logger,
      WagerTransactionConsumer.name,
    );
    this.client.destroy();
  }

  async pollOnce(): Promise<{ received: number; acknowledged: number }> {
    if (!this.acceptingMessages) {
      return { received: 0, acknowledged: 0 };
    }
    const operation = this.receiveAndProcess();
    this.activeOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.activeOperations.delete(operation);
    }
  }

  private async receiveAndProcess(): Promise<{
    received: number;
    acknowledged: number;
  }> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = response.Messages ?? [];
    if (!this.acceptingMessages) {
      return { received: messages.length, acknowledged: 0 };
    }
    let acknowledged = 0;
    for (const message of messages) {
      if (!this.acceptingMessages) {
        break;
      }
      const correlationId = this.messageCorrelationId(message) ?? randomUUID();
      try {
        await this.processMessageInCorrelationContext(message, correlationId);
        acknowledged += 1;
      } catch (error) {
        correlationContext.runWithCorrelationId(correlationId, () =>
          this.logger.warn(
            JSON.stringify({
              category: classifyWagerConsumerError(error),
              message: 'Wager message was not acknowledged',
              messageId: message.MessageId ?? null,
              error:
                error instanceof Error
                  ? { name: error.name, message: error.message }
                  : String(error),
            }),
            error instanceof Error ? error.stack : String(error),
          ),
        );
      }
    }
    return { received: messages.length, acknowledged };
  }

  async processMessage(message: Message): Promise<void> {
    const correlationId = this.messageCorrelationId(message) ?? randomUUID();
    return this.processMessageInCorrelationContext(message, correlationId);
  }

  private processMessageInCorrelationContext(
    message: Message,
    correlationId: string,
  ): Promise<void> {
    return correlationContext.runWithCorrelationId(correlationId, () =>
      this.processMessageInContext(message),
    );
  }

  private async processMessageInContext(message: Message): Promise<void> {
    if (!message.MessageId || !message.ReceiptHandle) {
      throw new Error(
        'SQS wager message requires a message id and receipt handle',
      );
    }
    const body = message.Body ?? '';
    let parsed: ParsedWagerMessage;
    try {
      parsed = parseWagerMessage(body);
    } catch (error) {
      if (classifyWagerConsumerError(error) !== 'terminal') {
        throw error;
      }
      if (error instanceof DomainError) {
        this.metrics?.recordTransaction('UNKNOWN', 'FAILED');
        this.metrics?.recordBusinessFailure(error.failureCode);
      }
      const payloadHash = createHash('sha256').update(body).digest('hex');
      await this.markTerminalMessage(message.MessageId, payloadHash, error);
      await this.acknowledge(message.ReceiptHandle);
      return;
    }
    const { input, idempotencyKey } = parsed;
    input.correlationId = correlationContext.get()?.correlationId;
    correlationContext.setAggregateId(input.walletId);
    const payloadHash = calculateWagerPayloadHash(input);

    try {
      let processedResult:
        | Awaited<ReturnType<ProcessWagerTransactionUseCase['execute']>>
        | undefined;
      const startedAt = performance.now();
      await this.em.transactional(async (em) => {
        const messageRecord = {
          consumerName: this.options.consumerName,
          messageId: message.MessageId!,
          payloadHash,
          correlationId: input.correlationId,
        };
        const inserted = await this.inbox.claim(messageRecord, em);
        if (!inserted) {
          const existing = await this.inbox.find(
            this.options.consumerName,
            message.MessageId!,
            em,
          );
          if (!existing) {
            throw new Error('Claimed inbox message disappeared in transaction');
          }
          if (existing.processedAt) {
            return;
          }
        }

        processedResult = await this.processWager.execute(
          input,
          idempotencyKey,
          em,
        );
        await this.inbox.markProcessed(
          this.options.consumerName,
          message.MessageId!,
          new Date(),
          em,
        );
      });
      if (
        processedResult &&
        !processedResult.idempotentReplay &&
        processedResult.transaction.status === WagerTransactionStatus.PROCESSED
      ) {
        this.metrics?.recordTransaction(input.kind, 'SUCCESS');
      } else if (
        processedResult &&
        !processedResult.idempotentReplay &&
        processedResult.transaction.status === WagerTransactionStatus.REJECTED
      ) {
        this.metrics?.recordTransaction(input.kind, 'REJECTED');
        if (processedResult.transaction.failureCode) {
          this.metrics?.recordBusinessFailure(
            processedResult.transaction.failureCode,
          );
        }
      }
      if (processedResult) {
        this.metrics?.observeProcessingDuration(
          input.kind,
          (performance.now() - startedAt) / 1_000,
        );
      }
    } catch (error) {
      if (classifyWagerConsumerError(error) !== 'terminal') {
        throw error;
      }
      await this.markTerminalMessage(message.MessageId, payloadHash, error);
    }

    await this.acknowledge(message.ReceiptHandle);
  }

  private async markTerminalMessage(
    messageId: string,
    payloadHash: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.em.transactional(async (em) => {
        const inserted = await this.inbox.claim(
          {
            consumerName: this.options.consumerName,
            messageId,
            payloadHash,
            correlationId: correlationContext.get()?.correlationId,
          },
          em,
        );
        if (inserted) {
          await this.inbox.markProcessed(
            this.options.consumerName,
            messageId,
            new Date(),
            em,
          );
          return;
        }

        const existing = await this.inbox.find(
          this.options.consumerName,
          messageId,
          em,
        );
        if (existing && !existing.processedAt) {
          await this.inbox.markProcessed(
            this.options.consumerName,
            messageId,
            new Date(),
            em,
          );
        }
      });
    } catch (inboxError) {
      if (classifyWagerConsumerError(inboxError) !== 'terminal') {
        throw inboxError;
      }
      this.logTerminalError(messageId, inboxError);
    }
    this.logTerminalError(messageId, error);
  }

  private messageCorrelationId(message: Message): string | undefined {
    const attribute = message.MessageAttributes?.correlationId?.StringValue;
    const validate = (value: string | undefined): string | undefined => {
      const candidate = value?.trim();
      return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)
        ? candidate
        : undefined;
    };
    const attributeId = validate(attribute);
    if (attributeId) {
      return attributeId;
    }
    try {
      const parsed: unknown = JSON.parse(message.Body ?? '');
      if (isRecord(parsed) && isString(parsed.correlationId)) {
        return validate(parsed.correlationId);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private logTerminalError(messageId: string, error: unknown): void {
    this.logger.warn(
      JSON.stringify({
        category: 'terminal',
        message: 'Wager message rejected as a permanent business failure',
        messageId,
        consumerName: this.options.consumerName,
        failureCode:
          error instanceof DomainError ? error.failureCode : 'INVALID_PAYLOAD',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private runScheduledPoll(): void {
    if (this.activePoll) {
      return;
    }
    this.activePoll = correlationContext.runWithCorrelationId(
      randomUUID(),
      () =>
        this.pollOnce()
          .then(({ received, acknowledged }) => {
            if (received > 0) {
              this.logger.log(
                `Wager queue poll complete: ${acknowledged}/${received} acknowledged`,
              );
            }
          })
          .catch((error: unknown) => {
            this.logger.error(
              'Wager queue poll failed',
              error instanceof Error ? error.stack : String(error),
            );
          })
          .finally(() => {
            this.activePoll = undefined;
          }),
    );
  }

  private validateOptions(options: WagerTransactionConsumerOptions): void {
    let queueUrl: URL;
    try {
      queueUrl = new URL(options.queueUrl);
    } catch {
      throw new Error('Wager consumer queue URL is invalid');
    }
    if (
      !options.consumerName.trim() ||
      (queueUrl.protocol !== 'http:' && queueUrl.protocol !== 'https:') ||
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 1 ||
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 10 ||
      !Number.isSafeInteger(options.waitTimeSeconds) ||
      options.waitTimeSeconds < 0 ||
      options.waitTimeSeconds > 20 ||
      !Number.isSafeInteger(options.visibilityTimeoutSeconds) ||
      options.visibilityTimeoutSeconds < 0 ||
      options.visibilityTimeoutSeconds > 43_200 ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) ||
      options.shutdownTimeoutMs < 1
    ) {
      throw new Error('Wager transaction consumer options are invalid');
    }
  }
}
