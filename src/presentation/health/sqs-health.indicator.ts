import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { HEALTH_SQS_CLIENT } from '../../infrastructure/metrics/metrics.tokens.js';

@Injectable()
export class SqsHealthIndicator implements OnModuleDestroy {
  constructor(
    @Inject(HEALTH_SQS_CLIENT) private readonly client: SQSClient,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  check() {
    return this.healthIndicator
      .check('sqs')
      .attempt(async ({ signal }) => {
        await this.client.send(new ListQueuesCommand({ MaxResults: 1 }), {
          abortSignal: signal,
        });
      })
      .withTimeout(2_000);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
