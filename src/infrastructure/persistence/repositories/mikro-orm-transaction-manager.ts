import type { EntityManager } from '@mikro-orm/core';

export class MikroOrmTransactionManager {
  constructor(private readonly em: EntityManager) {}

  transactional<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.em.transactional(work);
  }
}
