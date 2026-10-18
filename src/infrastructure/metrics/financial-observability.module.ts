import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { TerminusModule } from '@nestjs/terminus';
import { FinancialMetricsService } from './financial-metrics.service.js';
import { HealthController } from '../../presentation/health/health.controller.js';
import { PostgresHealthIndicator } from '../../presentation/health/postgres-health.indicator.js';
import { SqsHealthIndicator } from '../../presentation/health/sqs-health.indicator.js';
import { MetricsController } from '../../presentation/metrics/metrics.controller.js';
import { InboxMessageEntity } from '../persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../persistence/entities/outbox-message.entity.js';
import { createSqsClient } from '../messaging/sqs-client.provider.js';
import { HEALTH_SQS_CLIENT } from './metrics.tokens.js';

@Module({
  imports: [
    TerminusModule.forRoot(),
    MikroOrmModule.forFeature(
      [InboxMessageEntity, OutboxMessageEntity],
      'default',
    ),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    FinancialMetricsService,
    PostgresHealthIndicator,
    SqsHealthIndicator,
    {
      provide: HEALTH_SQS_CLIENT,
      useFactory: () => createSqsClient(),
    },
  ],
  exports: [FinancialMetricsService],
})
export class FinancialObservabilityModule {}
