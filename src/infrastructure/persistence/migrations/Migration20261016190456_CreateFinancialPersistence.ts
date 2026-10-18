import { Migration } from '@mikro-orm/migrations';

export class Migration20261016190456_CreateFinancialPersistence extends Migration {
  override name = 'Migration20261016190456_CreateFinancialPersistence';

  override up(): void {
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(255) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        primary key ("consumer_name", "message_id")
      );
    `);
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(255) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null default now(),
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        primary key ("id"),
        constraint "outbox_messages_attempts_nonnegative_ck" check ("attempts" >= 0)
      );
    `);
    this.addSql(`
      create index "outbox_messages_pending_idx"
      on "outbox_messages" ("next_attempt_at");
    `);
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(18, 2) not null,
        "version" int not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        primary key ("id"),
        constraint "wallets_player_currency_uq" unique ("player_id", "currency"),
        constraint "wallets_balance_nonnegative_ck" check ("balance" >= 0),
        constraint "wallets_version_positive_ck" check ("version" >= 1),
        constraint "wallets_currency_iso_code_ck" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(255) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(255) not null,
        "money_amount" numeric(18, 2) not null,
        "money_currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "status" varchar(255) not null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(255) null,
        "processed_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        primary key ("id"),
        constraint "wager_transactions_idempotency_key_uq" unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_uq"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_amount_positive_ck" check ("money_amount" > 0),
        constraint "wager_transactions_currency_iso_code_ck"
          check ("money_currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_idempotency_key_matches_ids_ck"
          check ("idempotency_key" = "provider_id" || ':' || "external_transaction_id"),
        constraint "wager_transactions_payload_hash_sha256_ck"
          check ("payload_hash" ~ '^[a-f0-9]{64}$'),
        constraint "wager_transactions_kind_valid_ck"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_valid_ck"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_reversal_requires_reference_ck"
          check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_failure_status_consistency_ck"
          check (
            ("status" in ('REJECTED', 'FAILED') and "failure_code" is not null)
            or ("status" not in ('REJECTED', 'FAILED') and "failure_code" is null)
          ),
        constraint "wager_transactions_processed_at_consistency_ck"
          check (
            ("status" = 'PROCESSED' and "processed_at" is not null)
            or ("status" <> 'PROCESSED' and "processed_at" is null)
          ),
        constraint "wager_transactions_wallet_id_foreign"
          foreign key ("wallet_id") references "wallets" ("id") on delete restrict,
        constraint "wager_transactions_reference_transaction_id_foreign"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id") on delete set null
      );
    `);
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(10) not null,
        "money_amount" numeric(18, 2) not null,
        "money_currency" varchar(3) not null,
        "balance_before_amount" numeric(18, 2) not null,
        "balance_before_currency" varchar(3) not null,
        "balance_after_amount" numeric(18, 2) not null,
        "balance_after_currency" varchar(3) not null,
        "created_at" timestamptz not null default now(),
        primary key ("id"),
        constraint "wallet_ledger_entries_transaction_id_uq" unique ("transaction_id"),
        constraint "wallet_ledger_entries_amount_positive_ck" check ("money_amount" > 0),
        constraint "wallet_ledger_entries_balances_nonnegative_ck"
          check ("balance_before_amount" >= 0 and "balance_after_amount" >= 0),
        constraint "wallet_ledger_entries_balance_consistency_ck"
          check (
            ("direction" = 'DEBIT'
              and "balance_before_amount" - "money_amount" = "balance_after_amount")
            or ("direction" = 'CREDIT'
              and "balance_before_amount" + "money_amount" = "balance_after_amount")
          ),
        constraint "wallet_ledger_entries_currency_consistency_ck"
          check (
            "money_currency" = "balance_before_currency"
            and "money_currency" = "balance_after_currency"
          ),
        constraint "wallet_ledger_entries_direction_valid_ck"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_currency_iso_code_ck"
          check (
            "money_currency" ~ '^[A-Z]{3}$'
            and "balance_before_currency" ~ '^[A-Z]{3}$'
            and "balance_after_currency" ~ '^[A-Z]{3}$'
          ),
        constraint "wallet_ledger_entries_wallet_id_foreign"
          foreign key ("wallet_id") references "wallets" ("id") on delete restrict,
        constraint "wallet_ledger_entries_transaction_id_foreign"
          foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict
      );
    `);
    this.addSql(`
      create index "wallet_ledger_entries_wallet_created_idx"
      on "wallet_ledger_entries" ("wallet_id", "created_at");
    `);
    this.addSql(`
      create or replace function "prevent_wallet_ledger_mutation"()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'wallet ledger entries are immutable';
      end;
      $function$;
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "prevent_wallet_ledger_mutation"();
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_no_truncate"
      before truncate on "wallet_ledger_entries"
      for each statement execute function "prevent_wallet_ledger_mutation"();
    `);
  }

  override down(): void {
    this.addSql(`
      drop trigger if exists "wallet_ledger_entries_no_truncate"
      on "wallet_ledger_entries";
    `);
    this.addSql(`
      drop trigger if exists "wallet_ledger_entries_immutable"
      on "wallet_ledger_entries";
    `);
    this.addSql('drop function if exists "prevent_wallet_ledger_mutation"();');
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop table if exists "inbox_messages";');
  }
}
