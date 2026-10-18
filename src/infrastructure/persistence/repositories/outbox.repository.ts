import { LockMode, type EntityManager } from '@mikro-orm/core';
import type {
  OutboxMessage,
  OutboxRepositoryPort,
} from '../../../application/ports/financial-persistence.js';
import { DomainError } from '../../../domain/domain-error.js';
import { FailureCode } from '../../../domain/failure-code.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { OutboxMessage as OutboxMessageDomain } from '../../../domain/entities/outbox-message.js';

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Outbox page limit must be a positive integer',
    );
  }
}

export class OutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async save(
    message: OutboxMessage,
    em: EntityManager = this.em,
  ): Promise<void> {
    const state = OutboxMessageDomain.enqueue(message).toState();
    const existing = await em.findOne(OutboxMessageEntity, { id: message.id });
    const data = {
      id: state.id,
      aggregateId: state.aggregateId,
      eventType: state.eventType,
      payload: state.payload,
      occurredAt: state.occurredAt,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      publishedAt: state.publishedAt,
    };
    if (existing) {
      Object.assign(existing, data);
    } else {
      em.persist(em.create(OutboxMessageEntity, data));
    }
    await em.flush();
  }

  async findPending(
    options: {
      limit?: number;
      now?: Date;
      lock?: boolean;
      em?: EntityManager;
    } = {},
  ): Promise<OutboxMessage[]> {
    const em = options.em ?? this.em;
    const limit = options.limit ?? 100;
    validateLimit(limit);
    const now = options.now ?? new Date();
    const entities = await em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: 'ASC', id: 'ASC' },
        limit,
        ...(options.lock
          ? { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE }
          : {}),
      },
    );
    return entities.map((entity) => this.toDomain(entity).toState());
  }

  async markPublished(
    id: string,
    publishedAt = new Date(),
    em: EntityManager = this.em,
  ): Promise<void> {
    const entity = await em.findOne(OutboxMessageEntity, { id });
    if (!entity) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Outbox message does not exist',
      );
    }
    const message = this.toDomain(entity);
    message.markPublished(publishedAt);
    this.applyState(entity, message.toState());
    await em.flush();
  }

  async scheduleRetry(
    id: string,
    retryPolicy: {
      now?: Date;
      baseDelayMs?: number;
      maxDelayMs?: number;
    } = {},
    em: EntityManager = this.em,
  ): Promise<Date> {
    const entity = await em.findOne(OutboxMessageEntity, { id });
    if (!entity) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Outbox message does not exist',
      );
    }
    const message = this.toDomain(entity);
    const nextAttemptAt = message.scheduleRetry(retryPolicy);
    this.applyState(entity, message.toState());
    await em.flush();
    return nextAttemptAt;
  }

  private toDomain(entity: OutboxMessageEntity): OutboxMessageDomain {
    return OutboxMessageDomain.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt ?? null,
      publishedAt: entity.publishedAt ?? null,
    });
  }

  private applyState(
    entity: OutboxMessageEntity,
    state: ReturnType<OutboxMessageDomain['toState']>,
  ): void {
    entity.attempts = state.attempts;
    entity.nextAttemptAt = state.nextAttemptAt;
    entity.publishedAt = state.publishedAt;
  }
}
