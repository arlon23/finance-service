import { Inject, Injectable } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxEventPublisher } from '../../application/ports/financial-persistence.js';
import {
  OUTBOX_SQS_CLIENT,
  OUTBOX_SQS_QUEUE_URLS,
} from '../../application/tokens.js';
import type { OutboxMessage } from '../../application/ports/financial-persistence.js';
import { correlationContext } from '../logging/correlation-context.js';
import { randomUUID } from 'node:crypto';

@Injectable()
export class SqsOutboxPublisher implements OutboxEventPublisher {
  constructor(
    @Inject(OUTBOX_SQS_CLIENT) private readonly client: SQSClient,
    @Inject(OUTBOX_SQS_QUEUE_URLS)
    private readonly queueUrls: Readonly<Record<string, string>>,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = this.queueUrls[message.eventType] ?? this.queueUrls['*'];
    if (!queueUrl) {
      throw new Error(
        `No SQS queue configured for outbox event ${message.eventType}`,
      );
    }
    const payloadCorrelationId = message.payload.correlationId;
    const correlationId =
      typeof payloadCorrelationId === 'string' && payloadCorrelationId.trim()
        ? payloadCorrelationId
        : (correlationContext.get()?.correlationId ?? randomUUID());

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message.payload),
      MessageAttributes: {
        eventId: {
          DataType: 'String',
          StringValue: message.id,
        },
        eventType: {
          DataType: 'String',
          StringValue: message.eventType,
        },
        aggregateId: {
          DataType: 'String',
          StringValue: message.aggregateId,
        },
        correlationId: {
          DataType: 'String',
          StringValue: correlationId,
        },
      },
      ...(queueUrl.endsWith('.fifo')
        ? {
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
          }
        : {}),
    });
    await this.client.send(command);
  }

  close(): void {
    this.client.destroy();
  }
}
