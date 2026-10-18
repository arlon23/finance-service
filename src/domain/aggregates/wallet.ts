import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';
import { Money } from '../value-objects/money.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  _balance: Money;
  _version: number;
  createdAt: Date;
  _updatedAt: Date;
}

export class Wallet {
  private _balance: Money;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this._createdAt = new Date(createdAt);
    this._updatedAt = new Date(updatedAt);
  }

  static open(props: OpenWalletProps): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Wallet id and playerId are required',
      );
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainError(
        FailureCode.INVALID_WALLET_BALANCE,
        'Wallet balance cannot be negative',
      );
    }
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state._balance,
      state._version,
      state.createdAt,
      state._updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(money: Money): void {
    this.debitWithFailureCode(money, FailureCode.NEGATIVE_BALANCE_PREVENTED);
  }

  debitWithFailureCode(
    money: Money,
    failureCode: FailureCode = FailureCode.NEGATIVE_BALANCE_PREVENTED,
  ): void {
    this.balanceAfterDebit(money, failureCode);
    this.updateBalance(this._balance.subtract(money));
  }

  balanceAfterDebit(
    money: Money,
    failureCode: FailureCode = FailureCode.NEGATIVE_BALANCE_PREVENTED,
  ): Money {
    this.assertCurrency(money);
    if (money.isNegative()) {
      throw new DomainError(
        FailureCode.INVALID_MONEY,
        'Debit amount cannot be negative',
      );
    }
    const nextBalance = this._balance.subtract(money);
    if (nextBalance.isNegative()) {
      throw new DomainError(
        failureCode,
        'Wallet balance cannot become negative',
      );
    }
    return nextBalance;
  }

  credit(money: Money): void {
    this.assertCurrency(money);
    if (money.isNegative()) {
      throw new DomainError(
        FailureCode.INVALID_MONEY,
        'Credit amount cannot be negative',
      );
    }
    this.updateBalance(this._balance.add(money));
  }

  private assertCurrency(money: Money): void {
    this._balance.assertSameCurrency(money);
  }

  private updateBalance(balance: Money): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date();
  }
}
