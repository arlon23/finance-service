import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import type {
  OutboxEventPublisher,
  OutboxRepositoryPort,
} from '../ports/financial-persistence.js';
import {
  OUTBOX_EVENT_PUBLISHER,
  OUTBOX_PROCESSOR_OPTIONS,
  OUTBOX_REPOSITORY,
} from '../tokens.js';
import { waitForGracefulDrain } from './graceful-drain.js';
import { randomUUID } from 'node:crypto';
import { correlationContext } from '../../infrastructure/logging/correlation-context.js';

export interface OutboxProcessorOptions {
  pollIntervalMs: number;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_OUTBOX_PROCESSOR_OPTIONS: OutboxProcessorOptions = {
  pollIntervalMs: 1_000,
  batchSize: 25,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 300_000,
  shutdownTimeoutMs: 30_000,
};

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  retried: number;
}

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private timer?: ReturnType<typeof setInterval>;
  private activeCycle?: Promise<void>;
  private shuttingDown = false;

  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
    @Inject(OUTBOX_REPOSITORY)
    private readonly outbox: OutboxRepositoryPort,
    @Optional()
    @Inject(OUTBOX_EVENT_PUBLISHER)
    private readonly publisher?: OutboxEventPublisher,
    @Optional()
    @Inject(OUTBOX_PROCESSOR_OPTIONS)
    private readonly options: OutboxProcessorOptions = DEFAULT_OUTBOX_PROCESSOR_OPTIONS,
  ) {
    this.validateOptions(options);
  }

  onModuleInit(): void {
    if (!this.publisher) {
      throw new Error(
        'Outbox event publisher must be configured before starting the processor',
      );
    }
    this.shuttingDown = false;
    this.timer = setInterval(
      () => this.runScheduledCycle(),
      this.options.pollIntervalMs,
    );
    this.timer.unref?.();
    this.runScheduledCycle();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const activeCycle = this.activeCycle;
    if (activeCycle) {
      await waitForGracefulDrain(
        [activeCycle],
        this.options.shutdownTimeoutMs,
        this.logger,
        OutboxProcessor.name,
      );
    }
    await this.publisher?.close?.();
  }

  async processBatch(now = new Date()): Promise<OutboxBatchResult> {
    const publisher = this.publisher;
    if (!publisher) {
      throw new Error(
        'Outbox event publisher must be configured before processing messages',
      );
    }
    return this.em.transactional(async (em) => {
      const messages = await this.outbox.findPending({
        limit: this.options.batchSize,
        now,
        lock: true,
        em,
      });
      const result: OutboxBatchResult = {
        claimed: messages.length,
        published: 0,
        retried: 0,
      };

      for (const message of messages) {
        const payloadCorrelationId = message.payload.correlationId;
        const correlationId =
          typeof payloadCorrelationId === 'string' &&
          payloadCorrelationId.trim()
            ? payloadCorrelationId
            : (correlationContext.get()?.correlationId ?? randomUUID());
        await correlationContext.runWithCorrelationId(
          correlationId,
          async () => {
            correlationContext.setAggregateId(message.aggregateId);
            try {
              await publisher.publish(message);
            } catch (error) {
              const nextAttemptAt = await this.outbox.scheduleRetry(
                message.id,
                {
                  now,
                  baseDelayMs: this.options.retryBaseDelayMs,
                  maxDelayMs: this.options.retryMaxDelayMs,
                },
                em,
              );
              result.retried += 1;
              this.logger.warn(
                `Outbox publish failed for ${message.id}; retry scheduled at ${nextAttemptAt.toISOString()}`,
                error instanceof Error ? error.stack : String(error),
              );
              return;
            }
            await this.outbox.markPublished(message.id, now, em);
            result.published += 1;
          },
          message.aggregateId,
        );
      }
      return result;
    });
  }

  private runScheduledCycle(): void {
    if (this.shuttingDown || this.activeCycle) {
      return;
    }
    this.activeCycle = correlationContext.runWithCorrelationId(
      randomUUID(),
      () =>
        this.processBatch()
          .then(({ claimed, published, retried }) => {
            if (claimed > 0) {
              this.logger.log(
                `Outbox batch complete: ${published} published, ${retried} retry scheduled`,
              );
            }
          })
          .catch((error: unknown) => {
            this.logger.error(
              'Outbox processing cycle failed',
              error instanceof Error ? error.stack : String(error),
            );
          })
          .finally(() => {
            this.activeCycle = undefined;
          }),
    );
  }

  private validateOptions(options: OutboxProcessorOptions): void {
    if (
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 1 ||
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      !Number.isSafeInteger(options.retryBaseDelayMs) ||
      options.retryBaseDelayMs < 1 ||
      !Number.isSafeInteger(options.retryMaxDelayMs) ||
      options.retryMaxDelayMs < options.retryBaseDelayMs ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) ||
      options.shutdownTimeoutMs < 1
    ) {
      throw new Error('Outbox processor options are invalid');
    }
  }
}
