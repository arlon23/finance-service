import { defineEntity, p } from '@mikro-orm/postgresql';

const WalletEntitySchema = defineEntity({
  name: 'WalletEntity',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid().fieldName('player_id'),
    currency: p.string().length(3),
    balance: p.decimal('string').precision(18).scale(2),
    version: p.integer().default(1),
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
    updatedAt: p
      .datetime()
      .fieldName('updated_at')
      .defaultRaw('now()')
      .onUpdate(() => new Date()),
  },
  uniques: [
    {
      name: 'wallets_player_currency_uq',
      properties: ['playerId', 'currency'],
    },
  ],
  checks: [
    {
      name: 'wallets_balance_nonnegative_ck',
      expression: 'balance >= 0',
    },
    {
      name: 'wallets_version_positive_ck',
      expression: 'version >= 1',
    },
    {
      name: 'wallets_currency_iso_code_ck',
      expression: "currency ~ '^[A-Z]{3}$'",
    },
  ],
});

export class WalletEntity extends WalletEntitySchema.class {}

WalletEntitySchema.setClass(WalletEntity);

export { WalletEntitySchema };
