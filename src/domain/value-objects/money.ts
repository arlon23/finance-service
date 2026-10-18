import { Decimal } from 'decimal.js';
import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';

export type MoneyProps = {
  amount: string;
  currency: string;
};

const amountPattern = /^\d+(?:\.\d{1,2})?$/;
const currencyPattern = /^[A-Z]{3}$/;

export class Money {
  private readonly _value: Decimal;

  private constructor(
    value: Decimal,
    readonly currency: string,
  ) {
    this._value = new Decimal(value);
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      !amountPattern.test(props.amount) ||
      !currencyPattern.test(props.currency)
    ) {
      throw new DomainError(
        props &&
          typeof props.currency === 'string' &&
          !currencyPattern.test(props.currency)
          ? FailureCode.INVALID_CURRENCY
          : FailureCode.INVALID_MONEY,
        'Money requires a non-negative decimal amount with at most two fractional digits and an uppercase ISO currency code',
      );
    }

    const value = new Decimal(props.amount);
    if (!value.isFinite() || value.isNegative()) {
      throw new DomainError(
        FailureCode.INVALID_MONEY,
        'Money amount must be finite and non-negative',
      );
    }
    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  get value(): Decimal {
    return new Decimal(this._value);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._value.plus(other._value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._value.minus(other._value), this.currency);
  }

  negate(): Money {
    return new Money(this._value.negated(), this.currency);
  }

  isZero(): boolean {
    return this._value.isZero();
  }

  isPositive(): boolean {
    return this._value.greaterThan(0);
  }

  isNegative(): boolean {
    return this._value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._value.lessThan(other._value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this._value.equals(other._value);
  }

  assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        FailureCode.INVALID_CURRENCY,
        `Cannot operate on ${this.currency} and ${other.currency}`,
      );
    }
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this._value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this._value.toFixed(2)} ${this.currency}`;
  }
}
