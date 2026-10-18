import type { LedgerEntry, TransactionRecord, Wallet } from './transaction.js';

export class IdempotencyKeyAlreadyClaimedError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'Idempotency key is already persisted by another transaction',
      options,
    );
    this.name = 'IdempotencyKeyAlreadyClaimedError';
  }
}

export interface FinancialUnitOfWork {
  findWallet(walletId: string): Promise<Wallet | null>;
  saveWallet(wallet: Wallet): Promise<void>;
  findTransactionByIdempotencyKey(
    key: string,
  ): Promise<TransactionRecord | null>;
  findTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRecord | null>;
  saveTransaction(
    transaction: TransactionRecord,
    isNew: boolean,
  ): Promise<void>;
  hasReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    operation: TransactionRecord['operation'],
    excludingExternalTransactionId: string,
  ): Promise<boolean>;
  appendLedgerEntry(entry: LedgerEntry): Promise<void>;
}

export interface FinancialRepository {
  withTransaction<T>(
    work: (unitOfWork: FinancialUnitOfWork) => Promise<T>,
  ): Promise<T>;
}
