import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';
import { Money } from '../value-objects/money.js';

export enum LedgerDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface WalletLedgerEntryState extends CreateWalletLedgerEntryProps {
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt);
    Object.freeze(this);
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    if (
      !Object.values(LedgerDirection).includes(props.direction) ||
      !props.id.trim() ||
      !props.walletId.trim() ||
      !props.transactionId.trim()
    ) {
      throw new DomainError(
        FailureCode.INVALID_LEDGER_ENTRY,
        'Ledger entry identifiers are required',
      );
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt ?? new Date()),
    );
    if (!entry.isBalanced()) {
      throw new DomainError(
        FailureCode.INVALID_LEDGER_ENTRY,
        'Ledger entry balances do not match its direction and amount',
      );
    }
    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (
      !this.money.isPositive() ||
      this.balanceBefore.isNegative() ||
      this.balanceAfter.isNegative() ||
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.DEBIT
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }
}
