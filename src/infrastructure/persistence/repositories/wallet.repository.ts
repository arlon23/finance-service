import { LockMode, type EntityManager } from '@mikro-orm/core';
import { Wallet } from '../../../domain/aggregates/wallet.js';
import type { WalletRepositoryPort } from '../../../application/ports/financial-persistence.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';

export class WalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(
    id: string,
    options: { lock?: boolean; em?: EntityManager } = {},
  ): Promise<Wallet | null> {
    const em = options.em ?? this.em;
    const entity = await em.findOne(
      WalletEntity,
      { id },
      options.lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {},
    );
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
    em: EntityManager = this.em,
  ): Promise<Wallet | null> {
    const entity = await em.findOne(WalletEntity, { playerId, currency });
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async save(wallet: Wallet, em: EntityManager = this.em): Promise<void> {
    const data = WalletMapper.toPersistence(wallet);
    const entity = await em.findOne(WalletEntity, { id: wallet.id });
    if (entity) {
      Object.assign(entity, data);
    } else {
      em.persist(data);
    }
    await em.flush();
  }
}
