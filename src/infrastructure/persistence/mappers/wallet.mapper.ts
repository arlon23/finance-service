import { Wallet } from '../../../domain/aggregates/wallet.js';
import { Money } from '../../../domain/value-objects/money.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class WalletMapper {
  static toPersistence(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  }

  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      _balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      _version: entity.version,
      createdAt: entity.createdAt,
      _updatedAt: entity.updatedAt,
    });
  }
}
