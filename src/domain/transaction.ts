import { Decimal } from 'decimal.js';
import { DomainError } from './domain-error.js';
import { FailureCode } from './failure-code.js';

export enum TransactionOperation {
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum TransactionStatus {
  NEW = 'NEW',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
}

export enum LedgerEntryType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface TransactionCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  operation: TransactionOperation;
  amount: string;
  referenceExternalTransactionId?: string;
}

export interface TransactionRecord extends TransactionCommand {
  id: string;
  status: TransactionStatus;
  failureCode?: FailureCode;
  payloadHash: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  walletId: string;
  type: LedgerEntryType;
  amount: string;
  currency: string;
  createdAt: string;
}

export interface Wallet {
  id: string;
  currency: string;
  balance: string;
}

const validTransitions: Record<
  TransactionStatus,
  readonly TransactionStatus[]
> = {
  [TransactionStatus.NEW]: [
    TransactionStatus.PENDING_REFERENCE,
    TransactionStatus.PROCESSED,
    TransactionStatus.REJECTED,
  ],
  [TransactionStatus.PENDING_REFERENCE]: [
    TransactionStatus.PROCESSED,
    TransactionStatus.REJECTED,
  ],
  [TransactionStatus.PROCESSED]: [],
  [TransactionStatus.REJECTED]: [],
};

export function transitionTransaction(
  transaction: TransactionRecord,
  status: TransactionStatus,
  failureCode?: FailureCode,
): TransactionRecord {
  if (!validTransitions[transaction.status].includes(status)) {
    throw new DomainError(
      FailureCode.INVALID_TRANSACTION_STATE,
      `Cannot transition transaction from ${transaction.status} to ${status}`,
    );
  }

  if (status === TransactionStatus.REJECTED && !failureCode) {
    throw new DomainError(
      FailureCode.INVALID_TRANSACTION_STATE,
      'A rejected transaction must include a failure code',
    );
  }
  if (status !== TransactionStatus.REJECTED && failureCode) {
    throw new DomainError(
      FailureCode.INVALID_TRANSACTION_STATE,
      'Only rejected transactions can include a failure code',
    );
  }

  return {
    ...transaction,
    status,
    failureCode,
    updatedAt: new Date().toISOString(),
  };
}

export function canonicalAmount(amount: string): string {
  try {
    const value = new Decimal(amount);
    if (
      !value.isFinite() ||
      value.lte(0) ||
      value.decimalPlaces() > 8 ||
      value.gte('1000000000000')
    ) {
      throw new Error('Amount is outside the supported precision');
    }
    return value.toString();
  } catch {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'amount must be a positive decimal number',
    );
  }
}

export function toMinorUnits(amount: string): bigint {
  try {
    const value = new Decimal(amount);
    if (!value.isFinite() || value.isNegative() || value.decimalPlaces() > 8) {
      throw new Error('Amount is outside the supported precision');
    }
    return BigInt(value.toFixed(8).replace('.', ''));
  } catch {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'amount must have at most eight decimal places',
    );
  }
}

export function fromMinorUnits(amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError(
      FailureCode.INVALID_CURRENCY,
      'currency must be a three-letter uppercase ISO code',
    );
  }
}
