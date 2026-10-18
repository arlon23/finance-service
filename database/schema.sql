CREATE TABLE IF NOT EXISTS wallets (
  id text PRIMARY KEY,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance numeric(20, 8) NOT NULL CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  external_transaction_id text NOT NULL,
  player_id text NOT NULL,
  wallet_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  round_id text NOT NULL,
  operation text NOT NULL CHECK (
    operation IN ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
  ),
  amount numeric(20, 8) NOT NULL CHECK (amount > 0),
  reference_external_transaction_id text,
  status text NOT NULL CHECK (
    status IN ('NEW', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED')
  ),
  failure_code text,
  payload_hash char(64) NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT financial_transactions_provider_external_uq
    UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT financial_transactions_idempotency_key_uq
    UNIQUE (idempotency_key),
  CHECK (
    (status = 'REJECTED' AND failure_code IS NOT NULL) OR
    (status <> 'REJECTED' AND failure_code IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_idempotency_key_uq
  ON financial_transactions (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_reversal_unique
  ON financial_transactions (
    provider_id,
    reference_external_transaction_id,
    operation
  )
  WHERE operation IN ('REFUND', 'ROLLBACK')
    AND status IN ('PENDING_REFERENCE', 'PROCESSED');

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES financial_transactions(id),
  wallet_id text NOT NULL REFERENCES wallets(id),
  type text NOT NULL CHECK (type IN ('DEBIT', 'CREDIT')),
  amount numeric(20, 8) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS ledger_entries_wallet_created_idx
  ON ledger_entries (wallet_id, created_at);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are immutable';
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
