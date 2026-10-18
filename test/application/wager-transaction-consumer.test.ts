import { describe, expect, it } from 'bun:test';
import { DomainError } from '../../src/domain/domain-error.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import { classifyWagerConsumerError } from '../../src/application/workers/wager-transaction-consumer.js';

describe('WagerTransactionConsumer error classification', () => {
  it('classifies terminal domain rejections separately from transient failures', () => {
    expect(
      classifyWagerConsumerError(
        new DomainError(FailureCode.INSUFFICIENT_FUNDS, 'Insufficient funds'),
      ),
    ).toBe('terminal');
    expect(
      classifyWagerConsumerError(
        new DomainError(FailureCode.INVALID_PAYLOAD, 'Invalid payload'),
      ),
    ).toBe('terminal');
    expect(
      classifyWagerConsumerError(
        new DomainError(FailureCode.WALLET_NOT_FOUND, 'Wallet not found'),
      ),
    ).toBe('terminal');
    expect(classifyWagerConsumerError(new Error('Database unavailable'))).toBe(
      'transient',
    );
    expect(
      classifyWagerConsumerError(
        new DomainError(
          FailureCode.REFERENCE_NOT_FOUND,
          'Referenced transaction has not arrived',
        ),
      ),
    ).toBe('transient');
  });
});
