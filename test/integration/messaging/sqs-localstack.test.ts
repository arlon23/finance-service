import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  createSqsClient,
  resolveSqsClientConfig,
} from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  SqsSetupService,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../../../src/infrastructure/messaging/sqs-setup.service.js';
import { SqsOutboxPublisher } from '../../../src/infrastructure/messaging/sqs-outbox-publisher.js';

const endpoint = process.env.SQS_TEST_ENDPOINT ?? 'http://127.0.0.1:4566';
const queueName = `wager-transactions-${crypto.randomUUID()}.fifo`;
const deadLetterQueueName = `wager-transactions-dlq-${crypto.randomUUID()}.fifo`;

let client: SQSClient;
let queueUrl: string;
let deadLetterQueueUrl: string;

describe('SQS LocalStack setup', () => {
  beforeAll(async () => {
    client = createSqsClient(
      { endpoint, region: 'us-east-1' },
      { NODE_ENV: 'test' },
    );
    const queues = await new SqsSetupService(client, {
      queueName,
      deadLetterQueueName,
      maxReceiveCount: 3,
    }).ensureWagerQueues();
    queueUrl = queues.queueUrl;
    deadLetterQueueUrl = queues.deadLetterQueueUrl;
  });

  afterAll(async () => {
    if (client) {
      if (queueUrl) {
        await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
      if (deadLetterQueueUrl) {
        await client.send(
          new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
        );
      }
      client.destroy();
    }
  });

  it('uses LocalStack defaults and the required FIFO queue names', () => {
    const config = resolveSqsClientConfig(
      {},
      { NODE_ENV: 'development', AWS_REGION: undefined },
    );
    expect(config).toMatchObject({
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    expect(WAGER_TRANSACTIONS_QUEUE).toBe('wager-transactions.fifo');
    expect(WAGER_TRANSACTIONS_DLQ).toBe('wager-transactions-dlq.fifo');
  });

  it('provisions FIFO queues with a redrive policy and sends/receives messages', async () => {
    const provisionedAgain = await new SqsSetupService(client, {
      queueName,
      deadLetterQueueName,
      maxReceiveCount: 3,
    }).ensureWagerQueues();
    expect(provisionedAgain).toEqual({ queueUrl, deadLetterQueueUrl });

    const queueAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'FifoQueue',
          'ContentBasedDeduplication',
          'RedrivePolicy',
        ],
      }),
    );
    const deadLetterAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['FifoQueue', 'ContentBasedDeduplication', 'QueueArn'],
      }),
    );

    expect(queueAttributes.Attributes).toMatchObject({
      FifoQueue: 'true',
      ContentBasedDeduplication: 'true',
    });
    expect(
      JSON.parse(queueAttributes.Attributes?.RedrivePolicy ?? '{}'),
    ).toMatchObject({
      deadLetterTargetArn: deadLetterAttributes.Attributes?.QueueArn,
      maxReceiveCount: '3',
    });
    expect(deadLetterAttributes.Attributes).toMatchObject({
      FifoQueue: 'true',
      ContentBasedDeduplication: 'true',
    });

    const eventId = crypto.randomUUID();
    const correlationId = `sqs-correlation-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      eventId,
      correlationId,
    });
    await new SqsOutboxPublisher(client, { TestEvent: queueUrl }).publish({
      id: eventId,
      aggregateId: crypto.randomUUID(),
      eventType: 'TestEvent',
      payload: { eventId, correlationId },
    });
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
      }),
    );
    const message = received.Messages?.[0];
    expect(JSON.parse(message?.Body ?? '')).toEqual(JSON.parse(body));
    expect(message?.MessageAttributes?.correlationId?.StringValue).toBe(
      correlationId,
    );
    const receiptHandle = message?.ReceiptHandle;
    if (!receiptHandle) {
      throw new Error('LocalStack SQS did not return a message receipt handle');
    }

    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  });

  it('moves repeatedly unacknowledged messages to the FIFO dead-letter queue', async () => {
    const body = JSON.stringify({ poisonMessage: crypto.randomUUID() });
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: 'poison-message-test',
      }),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const delivery = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 0,
        }),
      );
      if (delivery.Messages?.length === 0) {
        break;
      }
    }

    const deadLetterDelivery = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );
    const deadLetterMessage = deadLetterDelivery.Messages?.[0];
    expect(deadLetterMessage?.Body).toBe(body);
    if (!deadLetterMessage?.ReceiptHandle) {
      throw new Error(
        'LocalStack did not return the dead-letter receipt handle',
      );
    }
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        ReceiptHandle: deadLetterMessage.ReceiptHandle,
      }),
    );
  });
});
