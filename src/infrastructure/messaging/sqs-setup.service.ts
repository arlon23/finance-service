import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const WAGER_TRANSACTIONS_QUEUE = 'wager-transactions.fifo';
export const WAGER_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
export const DEFAULT_MAX_RECEIVE_COUNT = 5;

export interface SqsQueueSetupOptions {
  queueName?: string;
  deadLetterQueueName?: string;
  maxReceiveCount?: number;
}

export interface ProvisionedWagerQueues {
  queueUrl: string;
  deadLetterQueueUrl: string;
}

export class SqsSetupService {
  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsQueueSetupOptions = {},
  ) {}

  async ensureWagerQueues(): Promise<ProvisionedWagerQueues> {
    const queueName = this.options.queueName ?? WAGER_TRANSACTIONS_QUEUE;
    const deadLetterQueueName =
      this.options.deadLetterQueueName ?? WAGER_TRANSACTIONS_DLQ;
    const maxReceiveCount =
      this.options.maxReceiveCount ?? DEFAULT_MAX_RECEIVE_COUNT;
    this.validateOptions(queueName, deadLetterQueueName, maxReceiveCount);

    const deadLetterQueueUrl = await this.createFifoQueue(deadLetterQueueName);
    const deadLetterAttributes = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterQueueArn = deadLetterAttributes.Attributes?.QueueArn;
    if (!deadLetterQueueArn) {
      throw new Error(
        `SQS did not return an ARN for dead-letter queue ${deadLetterQueueName}`,
      );
    }

    const queueUrl = await this.createFifoQueue(queueName, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterQueueArn,
        maxReceiveCount: String(maxReceiveCount),
      }),
    });

    return { queueUrl, deadLetterQueueUrl };
  }

  private async createFifoQueue(
    queueName: string,
    extraAttributes: Record<string, string> = {},
  ): Promise<string> {
    const response = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          ...extraAttributes,
        },
      }),
    );
    if (!response.QueueUrl) {
      throw new Error(`SQS did not return a URL for queue ${queueName}`);
    }
    return response.QueueUrl;
  }

  private validateOptions(
    queueName: string,
    deadLetterQueueName: string,
    maxReceiveCount: number,
  ): void {
    if (
      !queueName.endsWith('.fifo') ||
      !deadLetterQueueName.endsWith('.fifo') ||
      queueName === deadLetterQueueName ||
      !Number.isSafeInteger(maxReceiveCount) ||
      maxReceiveCount < 1
    ) {
      throw new Error('SQS FIFO queue setup options are invalid');
    }
  }
}
