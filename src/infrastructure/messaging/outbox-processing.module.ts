import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { getEntityManagerToken, MikroOrmModule } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import {
  OUTBOX_EVENT_PUBLISHER,
  OUTBOX_PROCESSOR_OPTIONS,
  OUTBOX_REPOSITORY,
  OUTBOX_SQS_CLIENT,
  OUTBOX_SQS_QUEUE_URLS,
} from '../../application/tokens.js';
import {
  DEFAULT_OUTBOX_PROCESSOR_OPTIONS,
  OutboxProcessor,
  type OutboxProcessorOptions,
} from '../../application/workers/outbox-processor.js';
import { OutboxMessageEntity } from '../persistence/entities/outbox-message.entity.js';
import { OutboxRepository } from '../persistence/repositories/outbox.repository.js';
import { createSqsClient } from './sqs-client.provider.js';
import { SqsOutboxPublisher } from './sqs-outbox-publisher.js';

export interface OutboxProcessingModuleOptions {
  queueUrls: Readonly<Record<string, string>>;
  processor?: Partial<OutboxProcessorOptions>;
  region?: string;
  endpoint?: string;
}

@Module({})
export class OutboxProcessingModule {
  static registerSqs(options: OutboxProcessingModuleOptions): DynamicModule {
    const processorOptions: OutboxProcessorOptions = {
      ...DEFAULT_OUTBOX_PROCESSOR_OPTIONS,
      ...options.processor,
    };
    const clientOptions = {
      ...(options.region ? { region: options.region } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    };
    const queueUrls = { ...options.queueUrls };
    this.validateQueueUrls(queueUrls);

    const sqsClientProvider: Provider = {
      provide: OUTBOX_SQS_CLIENT,
      useFactory: () => createSqsClient(clientOptions),
    };

    return {
      module: OutboxProcessingModule,
      imports: [MikroOrmModule.forFeature([OutboxMessageEntity], 'default')],
      providers: [
        {
          provide: OutboxRepository,
          useFactory: (em: EntityManager) => new OutboxRepository(em),
          inject: [getEntityManagerToken('default')],
        },
        { provide: OUTBOX_SQS_QUEUE_URLS, useValue: queueUrls },
        {
          provide: OUTBOX_REPOSITORY,
          useExisting: OutboxRepository,
        },
        {
          provide: OUTBOX_PROCESSOR_OPTIONS,
          useValue: processorOptions,
        },
        sqsClientProvider,
        SqsOutboxPublisher,
        {
          provide: OUTBOX_EVENT_PUBLISHER,
          useExisting: SqsOutboxPublisher,
        },
        OutboxProcessor,
      ],
      exports: [OutboxProcessor],
    };
  }

  private static validateQueueUrls(
    queueUrls: Readonly<Record<string, string>>,
  ): void {
    if (!queueUrls || Object.keys(queueUrls).length === 0) {
      throw new Error('At least one SQS queue URL must be configured');
    }
    for (const [eventType, queueUrl] of Object.entries(queueUrls)) {
      let parsed: URL;
      try {
        parsed = new URL(queueUrl);
      } catch {
        throw new Error(`Invalid SQS URL configured for ${eventType}`);
      }
      if (
        !eventType.trim() ||
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      ) {
        throw new Error(`Invalid SQS URL configured for ${eventType}`);
      }
    }
  }
}
