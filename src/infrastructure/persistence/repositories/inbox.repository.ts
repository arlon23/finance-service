import type { EntityManager } from '@mikro-orm/core';
import type {
  InboxMessage,
  InboxRepositoryPort,
} from '../../../application/ports/financial-persistence.js';
import { DomainError } from '../../../domain/domain-error.js';
import { InboxMessage as InboxMessageDomain } from '../../../domain/entities/inbox-message.js';
import { FailureCode } from '../../../domain/failure-code.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';

interface InsertedInboxRow {
  message_id: string;
}

export class InboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async claim(
    message: InboxMessage,
    em: EntityManager = this.em,
  ): Promise<boolean> {
    const received = InboxMessageDomain.receive(message);
    const schema = em.schema ?? em.config.get('schema');
    const tableName = schema
      ? `"${schema.replaceAll('"', '""')}"."inbox_messages"`
      : '"inbox_messages"';
    const result = await em.getConnection().execute<InsertedInboxRow>(
      `insert into ${tableName} (
         "consumer_name", "message_id", "payload_hash", "correlation_id", "received_at", "processed_at"
       ) values (?, ?, ?, ?, ?, ?)
       on conflict ("consumer_name", "message_id") do nothing
       returning "message_id"`,
      [
        received.consumerName,
        received.messageId,
        received.payloadHash,
        received.correlationId ?? null,
        received.receivedAt,
        received.processedAt,
      ],
      'all',
      em.getTransactionContext(),
    );
    const insertedCount = Array.isArray(result)
      ? result.length
      : (result.rows?.length ?? 0);
    if (insertedCount > 0) {
      return true;
    }

    const existing = await this.find(
      received.consumerName,
      received.messageId,
      em,
    );
    if (!existing) {
      throw new Error('Inbox message conflict occurred but no row was found');
    }
    if (existing.payloadHash !== received.payloadHash) {
      throw new DomainError(
        FailureCode.IDEMPOTENCY_CONFLICT,
        'Inbox message id was already claimed with a different payload',
      );
    }
    return false;
  }

  async find(
    consumerName: string,
    messageId: string,
    em: EntityManager = this.em,
  ): Promise<InboxMessageDomain | null> {
    const entity = await em.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    return entity
      ? InboxMessageDomain.rehydrate({
          consumerName: entity.consumerName,
          messageId: entity.messageId,
          payloadHash: entity.payloadHash,
          correlationId: entity.correlationId ?? undefined,
          receivedAt: entity.receivedAt,
          processedAt: entity.processedAt ?? null,
        })
      : null;
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    processedAt = new Date(),
    em: EntityManager = this.em,
  ): Promise<void> {
    const inboxMessage = await this.find(consumerName, messageId, em);
    if (!inboxMessage) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Cannot mark an unclaimed inbox message as processed',
      );
    }
    inboxMessage.markProcessed(processedAt);
    const entity = await em.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    if (!entity) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Inbox message disappeared before it was marked as processed',
      );
    }
    entity.processedAt = inboxMessage.processedAt;
    await em.flush();
  }
}
