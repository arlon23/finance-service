import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity.js';

const WagerTransactionEntitySchema = defineEntity({
  name: 'WagerTransactionEntity',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().fieldName('provider_id'),
    externalTransactionId: p.string().fieldName('external_transaction_id'),
    idempotencyKey: p
      .string()
      .fieldName('idempotency_key')
      .unique('wager_transactions_idempotency_key_uq'),
    payloadHash: p.string().fieldName('payload_hash').length(64),
    walletId: () =>
      p
        .manyToOne(WalletEntity)
        .mapToPk()
        .fieldName('wallet_id')
        .deleteRule('restrict'),
    playerId: p.uuid().fieldName('player_id'),
    roundId: p.string().fieldName('round_id'),
    gameId: p.string().fieldName('game_id'),
    kind: p.string().fieldName('kind'),
    moneyAmount: p
      .decimal('string')
      .precision(18)
      .scale(2)
      .fieldName('money_amount'),
    moneyCurrency: p.string().length(3).fieldName('money_currency'),
    referenceExternalTransactionId: p
      .string()
      .fieldName('reference_external_transaction_id')
      .nullable(),
    status: p.string(),
    referenceTransactionId: () =>
      p
        .manyToOne(WagerTransactionEntity)
        .mapToPk()
        .fieldName('reference_transaction_id')
        .nullable()
        .deleteRule('set null'),
    failureCode: p.string().fieldName('failure_code').nullable(),
    processedAt: p.datetime().fieldName('processed_at').nullable(),
    resultingBalanceAmount: p
      .decimal('string')
      .precision(18)
      .scale(2)
      .fieldName('resulting_balance_amount')
      .nullable(),
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
    updatedAt: p.datetime().fieldName('updated_at').defaultRaw('now()'),
  },
  uniques: [
    {
      name: 'wager_transactions_provider_external_uq',
      properties: ['providerId', 'externalTransactionId'],
    },
  ],
  checks: [
    {
      name: 'wager_transactions_amount_positive_ck',
      expression: 'money_amount > 0',
    },
    {
      name: 'wager_transactions_currency_iso_code_ck',
      expression: "money_currency ~ '^[A-Z]{3}$'",
    },
    {
      name: 'wager_transactions_idempotency_key_matches_ids_ck',
      expression:
        "idempotency_key = provider_id || ':' || external_transaction_id",
    },
    {
      name: 'wager_transactions_payload_hash_sha256_ck',
      expression: "payload_hash ~ '^[a-f0-9]{64}$'",
    },
    {
      name: 'wager_transactions_kind_valid_ck',
      expression:
        "kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
    },
    {
      name: 'wager_transactions_status_valid_ck',
      expression:
        "status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
    },
    {
      name: 'wager_transactions_reversal_requires_reference_ck',
      expression:
        "(kind NOT IN ('REFUND', 'ROLLBACK')) OR reference_external_transaction_id IS NOT NULL",
    },
    {
      name: 'wager_transactions_failure_status_consistency_ck',
      expression:
        "(status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL) OR (status NOT IN ('REJECTED', 'FAILED') AND failure_code IS NULL)",
    },
    {
      name: 'wager_transactions_processed_at_consistency_ck',
      expression:
        "(status = 'PROCESSED' AND processed_at IS NOT NULL) OR (status <> 'PROCESSED' AND processed_at IS NULL)",
    },
  ],
});

export class WagerTransactionEntity
  extends WagerTransactionEntitySchema.class {}

WagerTransactionEntitySchema.setClass(WagerTransactionEntity);

export { WagerTransactionEntitySchema };
