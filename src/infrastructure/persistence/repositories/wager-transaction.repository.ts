import type { EntityManager } from '@mikro-orm/core';
import type { WagerTransactionRepositoryPort } from '../../../application/ports/financial-persistence.js';
import {
  WagerTransaction,
  type WagerTransactionKind,
} from '../../../domain/entities/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';
import { WagerTransactionStatus } from '../../../domain/entities/wager-transaction.js';

export class WagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(
    id: string,
    em: EntityManager = this.em,
  ): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, { id });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByIdempotencyKey(
    key: string,
    em: EntityManager = this.em,
  ): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: key,
    });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
    em: EntityManager = this.em,
  ): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId: externalId,
    });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findReversals(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
    em: EntityManager = this.em,
  ): Promise<WagerTransaction[]> {
    const entities = await em.find(WagerTransactionEntity, {
      providerId,
      referenceExternalTransactionId,
      kind,
      status: {
        $in: [
          WagerTransactionStatus.PENDING_REFERENCE,
          WagerTransactionStatus.PROCESSED,
        ],
      },
    });
    return entities.map((entity) => WagerTransactionMapper.toDomain(entity));
  }

  async save(
    transaction: WagerTransaction,
    em: EntityManager = this.em,
  ): Promise<void> {
    const data = WagerTransactionMapper.toPersistence(transaction);
    const entity = await em.findOne(WagerTransactionEntity, {
      id: transaction.id,
    });
    if (entity) {
      Object.assign(entity, data);
    } else {
      em.persist(data);
    }
    await em.flush();
  }
}
