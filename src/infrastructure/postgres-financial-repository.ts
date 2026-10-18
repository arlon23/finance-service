import { Injectable } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { DomainError } from '../domain/domain-error.js';
import { FailureCode } from '../domain/failure-code.js';
import type {
  FinancialRepository,
  FinancialUnitOfWork,
} from '../domain/financial-repository.js';
import { IdempotencyKeyAlreadyClaimedError } from '../domain/financial-repository.js';
import type {
  LedgerEntry,
  TransactionOperation,
  TransactionRecord,
  TransactionStatus,
  Wallet,
} from '../domain/transaction.js';
import { canonicalAmount } from '../domain/transaction.js';

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  player_id: string;
  wallet_id: string;
  currency: string;
  round_id: string;
  operation: TransactionOperation;
  amount: string;
  reference_external_transaction_id: string | null;
  status: TransactionStatus;
  failure_code: FailureCode | null;
  payload_hash: string;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

function toTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    currency: row.currency,
    roundId: row.round_id,
    operation: row.operation,
    amount: canonicalAmount(row.amount),
    referenceExternalTransactionId:
      row.reference_external_transaction_id ?? undefined,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueConstraintError(
  error: unknown,
): error is { code: '23505'; constraint: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    typeof error.constraint === 'string'
  );
}

class PostgresUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly client: PoolClient) {}

  async findWallet(walletId: string): Promise<Wallet | null> {
    const result = await this.client.query<{
      id: string;
      currency: string;
      balance: string;
    }>('SELECT id, currency, balance FROM wallets WHERE id = $1 FOR UPDATE', [
      walletId,
    ]);
    const row = result.rows[0];
    return row
      ? { id: row.id, currency: row.currency, balance: row.balance }
      : null;
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const result = await this.client.query(
      'UPDATE wallets SET balance = $2, updated_at = now() WHERE id = $1',
      [wallet.id, wallet.balance],
    );
    if (result.rowCount !== 1) {
      throw new DomainError(
        FailureCode.WALLET_NOT_FOUND,
        'Wallet disappeared during transaction processing',
      );
    }
  }

  async findTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRecord | null> {
    const result = await this.client.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2
       FOR UPDATE`,
      [providerId, externalTransactionId],
    );
    return result.rows[0] ? toTransaction(result.rows[0]) : null;
  }

  async findTransactionByIdempotencyKey(
    key: string,
  ): Promise<TransactionRecord | null> {
    const result = await this.client.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE idempotency_key = $1
       FOR UPDATE`,
      [key],
    );
    return result.rows[0] ? toTransaction(result.rows[0]) : null;
  }

  async saveTransaction(
    transaction: TransactionRecord,
    isNew: boolean,
  ): Promise<void> {
    const values = [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.playerId,
      transaction.walletId,
      transaction.currency,
      transaction.roundId,
      transaction.operation,
      transaction.amount,
      transaction.referenceExternalTransactionId ?? null,
      transaction.status,
      transaction.failureCode ?? null,
      transaction.payloadHash,
      transaction.idempotencyKey,
      transaction.createdAt,
      transaction.updatedAt,
    ];
    let result;
    try {
      result = isNew
        ? await this.client.query(
            `INSERT INTO financial_transactions (
             id, provider_id, external_transaction_id, player_id, wallet_id,
             currency, round_id, operation, amount,
             reference_external_transaction_id, status, failure_code,
             payload_hash, idempotency_key, created_at, updated_at
            ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16
             )`,
            values,
          )
        : await this.client.query(
            `UPDATE financial_transactions
             SET status = $2, failure_code = $3, updated_at = $4
             WHERE id = $1`,
            [
              transaction.id,
              transaction.status,
              transaction.failureCode ?? null,
              transaction.updatedAt,
            ],
          );
    } catch (error) {
      if (
        isNew &&
        isUniqueConstraintError(error) &&
        [
          'financial_transactions_idempotency_key_uq',
          'financial_transactions_provider_external_uq',
          'financial_transactions_provider_id_external_transaction_id_key',
        ].includes(error.constraint)
      ) {
        throw new IdempotencyKeyAlreadyClaimedError({ cause: error });
      }
      throw error;
    }
    if (result.rowCount !== 1) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Transaction could not be persisted',
      );
    }
  }

  async hasReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    operation: TransactionOperation,
    excludingExternalTransactionId: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM financial_transactions
       WHERE provider_id = $1
         AND reference_external_transaction_id = $2
         AND operation = $3
         AND external_transaction_id <> $4
         AND status IN ('PENDING_REFERENCE', 'PROCESSED')
       LIMIT 1`,
      [
        providerId,
        referenceExternalTransactionId,
        operation,
        excludingExternalTransactionId,
      ],
    );
    return result.rowCount !== 0;
  }

  async appendLedgerEntry(entry: LedgerEntry): Promise<void> {
    await this.client.query(
      `INSERT INTO ledger_entries (
         id, transaction_id, wallet_id, type, amount, currency, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        entry.transactionId,
        entry.walletId,
        entry.type,
        entry.amount,
        entry.currency,
        entry.createdAt,
      ],
    );
  }
}

@Injectable()
export class PostgresFinancialRepository implements FinancialRepository {
  private readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/financial_db',
  });

  async withTransaction<T>(
    work: (unitOfWork: FinancialUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const result = await work(new PostgresUnitOfWork(client));
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Transaction failed and PostgreSQL rollback also failed',
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
