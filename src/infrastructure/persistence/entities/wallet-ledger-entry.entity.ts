import { defineEntity, p } from '@mikro-orm/postgresql';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletEntity } from './wallet.entity.js';

const WalletLedgerEntryEntitySchema = defineEntity({
  name: 'WalletLedgerEntryEntity',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: () =>
      p
        .manyToOne(WalletEntity)
        .mapToPk()
        .fieldName('wallet_id')
        .deleteRule('restrict'),
    transactionId: () =>
      p
        .manyToOne(WagerTransactionEntity)
        .fieldName('transaction_id')
        .mapToPk()
        .unique('wallet_ledger_entries_transaction_id_uq')
        .deleteRule('restrict'),
    direction: p.string().length(10),
    moneyAmount: p
      .decimal('string')
      .precision(18)
      .scale(2)
      .fieldName('money_amount'),
    moneyCurrency: p.string().length(3).fieldName('money_currency'),
    balanceBeforeAmount: p
      .decimal('string')
      .precision(18)
      .scale(2)
      .fieldName('balance_before_amount'),
    balanceBeforeCurrency: p
      .string()
      .length(3)
      .fieldName('balance_before_currency'),
    balanceAfterAmount: p
      .decimal('string')
      .precision(18)
      .scale(2)
      .fieldName('balance_after_amount'),
    balanceAfterCurrency: p
      .string()
      .length(3)
      .fieldName('balance_after_currency'),
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
  },
  checks: [
    {
      name: 'wallet_ledger_entries_amount_positive_ck',
      expression: 'money_amount > 0',
    },
    {
      name: 'wallet_ledger_entries_balances_nonnegative_ck',
      expression: 'balance_before_amount >= 0 AND balance_after_amount >= 0',
    },
    {
      name: 'wallet_ledger_entries_balance_consistency_ck',
      expression:
        "(direction = 'DEBIT' AND balance_before_amount - money_amount = balance_after_amount) OR (direction = 'CREDIT' AND balance_before_amount + money_amount = balance_after_amount)",
    },
    {
      name: 'wallet_ledger_entries_currency_consistency_ck',
      expression:
        'money_currency = balance_before_currency AND money_currency = balance_after_currency',
    },
    {
      name: 'wallet_ledger_entries_direction_valid_ck',
      expression: "direction IN ('DEBIT', 'CREDIT')",
    },
    {
      name: 'wallet_ledger_entries_currency_iso_code_ck',
      expression:
        "money_currency ~ '^[A-Z]{3}$' AND balance_before_currency ~ '^[A-Z]{3}$' AND balance_after_currency ~ '^[A-Z]{3}$'",
    },
  ],
});

export class WalletLedgerEntryEntity
  extends WalletLedgerEntryEntitySchema.class {}

WalletLedgerEntryEntitySchema.setClass(WalletLedgerEntryEntity);

export { WalletLedgerEntryEntitySchema };
