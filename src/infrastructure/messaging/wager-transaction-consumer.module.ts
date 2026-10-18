import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { getEntityManagerToken, MikroOrmModule } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import {
  INBOX_REPOSITORY,
  WAGER_CONSUMER_OPTIONS,
  WAGER_CONSUMER_QUEUE_URL,
  WAGER_CONSUMER_SQS_CLIENT,
} from '../../application/tokens.js';
import {
  DEFAULT_WAGER_TRANSACTION_CONSUMER_OPTIONS,
  WagerTransactionConsumer,
  type WagerTransactionConsumerOptions,
} from '../../application/workers/wager-transaction-consumer.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { FinancialUseCasesModule } from '../../application/financial-use-cases.module.js';
import { InboxMessageEntity } from '../persistence/entities/inbox-message.entity.js';
import { InboxRepository } from '../persistence/repositories/inbox.repository.js';
import {
  createSqsClient,
  resolveSqsClientConfig,
} from './sqs-client.provider.js';
import {
  SqsSetupService,
  type SqsQueueSetupOptions,
} from './sqs-setup.service.js';
import { FinancialMetricsService } from '../metrics/financial-metrics.service.js';

export interface WagerTransactionConsumerModuleOptions {
  consumerName: string;
  queueUrl?: string;
  processor?: Partial<
    Omit<WagerTransactionConsumerOptions, 'consumerName' | 'queueUrl'>
  >;
  region?: string;
  endpoint?: string;
  setupQueue?: boolean;
  queueSetup?: SqsQueueSetupOptions;
}

@Module({})
export class WagerTransactionConsumerModule {
  static registerSqs(
    options: WagerTransactionConsumerModuleOptions,
  ): DynamicModule {
    if (!options.consumerName?.trim()) {
      throw new Error('A non-empty SQS consumer name is required');
    }
    const clientOptions = {
      ...(options.region ? { region: options.region } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    };
    const hasLocalEndpoint = Boolean(
      resolveSqsClientConfig(clientOptions).endpoint,
    );
    const setupQueue =
      options.setupQueue ?? (!options.queueUrl && hasLocalEndpoint);
    if (!options.queueUrl && !setupQueue) {
      throw new Error(
        'Configure an SQS queue URL or enable local queue provisioning',
      );
    }

    const clientProvider: Provider = {
      provide: WAGER_CONSUMER_SQS_CLIENT,
      useFactory: () => createSqsClient(clientOptions),
    };
    const queueUrlProvider: Provider = {
      provide: WAGER_CONSUMER_QUEUE_URL,
      useFactory: async (client: ReturnType<typeof createSqsClient>) => {
        if (options.queueUrl) {
          return options.queueUrl;
        }
        const queues = await new SqsSetupService(
          client,
          options.queueSetup,
        ).ensureWagerQueues();
        return queues.queueUrl;
      },
      inject: [WAGER_CONSUMER_SQS_CLIENT],
    };
    const consumerOptionsProvider: Provider = {
      provide: WAGER_CONSUMER_OPTIONS,
      useFactory: (queueUrl: string): WagerTransactionConsumerOptions => ({
        ...DEFAULT_WAGER_TRANSACTION_CONSUMER_OPTIONS,
        ...options.processor,
        consumerName: options.consumerName,
        queueUrl,
      }),
      inject: [WAGER_CONSUMER_QUEUE_URL],
    };

    return {
      module: WagerTransactionConsumerModule,
      imports: [
        FinancialUseCasesModule,
        MikroOrmModule.forFeature([InboxMessageEntity], 'default'),
      ],
      providers: [
        {
          provide: InboxRepository,
          useFactory: (em: EntityManager) => new InboxRepository(em),
          inject: [getEntityManagerToken('default')],
        },
        { provide: INBOX_REPOSITORY, useExisting: InboxRepository },
        clientProvider,
        queueUrlProvider,
        consumerOptionsProvider,
        {
          provide: WagerTransactionConsumer,
          useFactory: (
            em: EntityManager,
            inbox: InboxRepository,
            processWager: ProcessWagerTransactionUseCase,
            client: ReturnType<typeof createSqsClient>,
            consumerOptions: WagerTransactionConsumerOptions,
            metrics: FinancialMetricsService,
          ) =>
            new WagerTransactionConsumer(
              em,
              inbox,
              processWager,
              client,
              consumerOptions,
              metrics,
            ),
          inject: [
            getEntityManagerToken('default'),
            INBOX_REPOSITORY,
            ProcessWagerTransactionUseCase,
            WAGER_CONSUMER_SQS_CLIENT,
            WAGER_CONSUMER_OPTIONS,
            FinancialMetricsService,
          ],
        },
      ],
      exports: [WagerTransactionConsumer],
    };
  }
}
