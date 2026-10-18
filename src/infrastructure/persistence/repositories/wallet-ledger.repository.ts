import type { EntityManager } from '@mikro-orm/core';
import type { WalletLedgerRepositoryPort } from '../../../application/ports/financial-persistence.js';
import { DomainError } from '../../../domain/domain-error.js';
import { FailureCode } from '../../../domain/failure-code.js';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Ledger page limit must be a positive integer',
    );
  }
}

export class WalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async save(
    entry: WalletLedgerEntry,
    em: EntityManager = this.em,
  ): Promise<void> {
    em.persist(WalletLedgerEntryMapper.toPersistence(entry));
    await em.flush();
  }

  async findByWalletId(
    walletId: string,
    options: { limit?: number; cursor?: string; em?: EntityManager } = {},
  ): Promise<WalletLedgerEntry[]> {
    const em = options.em ?? this.em;
    const limit = options.limit ?? 100;
    validateLimit(limit);

    let where: Record<string, unknown> = { walletId };
    if (options.cursor) {
      const cursor = await em.findOne(WalletLedgerEntryEntity, {
        id: options.cursor,
        walletId,
      });
      if (!cursor) {
        throw new DomainError(
          FailureCode.INVALID_PAYLOAD,
          'Ledger cursor does not belong to the requested wallet',
        );
      }
      where = {
        walletId,
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { $lt: cursor.id } },
        ],
      };
    }

    const entities = await em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: 'DESC', id: 'DESC' },
      limit,
    });
    return entities.map((entity) => WalletLedgerEntryMapper.toDomain(entity));
  }
}
