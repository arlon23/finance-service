import { DomainError } from '../domain/domain-error.js';
import { FailureCode } from '../domain/failure-code.js';
import type {
  FinancialRepository,
  FinancialUnitOfWork,
} from '../domain/financial-repository.js';
import { IdempotencyKeyAlreadyClaimedError } from '../domain/financial-repository.js';
import type {
  LedgerEntry,
  TransactionRecord,
  Wallet,
} from '../domain/transaction.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class InMemoryUnitOfWork implements FinancialUnitOfWork {
  constructor(
    private readonly wallets: Map<string, Wallet>,
    private readonly transactions: Map<string, TransactionRecord>,
    private readonly ledgerEntries: LedgerEntry[],
  ) {}

  async findWallet(walletId: string): Promise<Wallet | null> {
    const wallet = this.wallets.get(walletId);
    return wallet ? clone(wallet) : null;
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    this.wallets.set(wallet.id, clone(wallet));
  }

  async findTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRecord | null> {
    const transaction = [...this.transactions.values()].find(
      (item) =>
        item.providerId === providerId &&
        item.externalTransactionId === externalTransactionId,
    );
    return transaction ? clone(transaction) : null;
  }

  async findTransactionByIdempotencyKey(
    key: string,
  ): Promise<TransactionRecord | null> {
    const transaction = [...this.transactions.values()].find(
      (item) => item.idempotencyKey === key,
    );
    return transaction ? clone(transaction) : null;
  }

  async saveTransaction(
    transaction: TransactionRecord,
    isNew: boolean,
  ): Promise<void> {
    const key = this.transactionKey(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (isNew && this.transactions.has(key)) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Transaction already exists',
      );
    }
    if (
      isNew &&
      [...this.transactions.values()].some(
        (item) => item.idempotencyKey === transaction.idempotencyKey,
      )
    ) {
      throw new IdempotencyKeyAlreadyClaimedError();
    }
    if (!isNew && !this.transactions.has(key)) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Transaction does not exist',
      );
    }
    this.transactions.set(key, clone(transaction));
  }

  async hasReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    operation: TransactionRecord['operation'],
    excludingExternalTransactionId: string,
  ): Promise<boolean> {
    return [...this.transactions.values()].some(
      (transaction) =>
        transaction.providerId === providerId &&
        transaction.referenceExternalTransactionId ===
          referenceExternalTransactionId &&
        transaction.externalTransactionId !== excludingExternalTransactionId &&
        transaction.operation === operation &&
        ['PENDING_REFERENCE', 'PROCESSED'].includes(transaction.status),
    );
  }

  async appendLedgerEntry(entry: LedgerEntry): Promise<void> {
    this.ledgerEntries.push(clone(entry));
  }

  private transactionKey(providerId: string, externalTransactionId: string) {
    return `${providerId}:${externalTransactionId}`;
  }
}

export class InMemoryFinancialRepository implements FinancialRepository {
  private wallets = new Map<string, Wallet>();
  private transactions = new Map<string, TransactionRecord>();
  private ledgerEntries: LedgerEntry[] = [];
  private lock: Promise<void> = Promise.resolve();

  async withTransaction<T>(
    work: (unitOfWork: FinancialUnitOfWork) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const previousLock = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousLock;

    const wallets = new Map(
      [...this.wallets].map(([key, value]) => [key, clone(value)]),
    );
    const transactions = new Map(
      [...this.transactions].map(([key, value]) => [key, clone(value)]),
    );
    const ledgerEntries = clone(this.ledgerEntries);
    try {
      const result = await work(
        new InMemoryUnitOfWork(wallets, transactions, ledgerEntries),
      );
      this.wallets = wallets;
      this.transactions = transactions;
      this.ledgerEntries = ledgerEntries;
      return result;
    } finally {
      release();
    }
  }

  seedWallet(wallet: Wallet): void {
    this.wallets.set(wallet.id, clone(wallet));
  }

  getWallet(walletId: string): Wallet | null {
    const wallet = this.wallets.get(walletId);
    return wallet ? clone(wallet) : null;
  }

  getTransactions(): TransactionRecord[] {
    return clone([...this.transactions.values()]);
  }

  getLedgerEntries(): LedgerEntry[] {
    return clone(this.ledgerEntries);
  }
}
