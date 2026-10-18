import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../src/domain/entities/outbox-message.js';

describe('OutboxMessage', () => {
  const occurredAt = new Date('2026-10-17T12:00:00.000Z');

  function create(): OutboxMessage {
    return OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { amount: '0.01', currency: 'USD' },
      occurredAt,
    });
  }

  it('starts pending and applies capped exponential retry backoff', () => {
    const message = create();

    expect(message.isPending(occurredAt)).toBe(true);
    expect(
      message.scheduleRetry({
        now: occurredAt,
        baseDelayMs: 100,
        maxDelayMs: 350,
      }),
    ).toEqual(new Date(occurredAt.getTime() + 100));
    expect(message.attempts).toBe(1);
    expect(message.isPending(new Date(occurredAt.getTime() + 99))).toBe(false);
    expect(message.isPending(new Date(occurredAt.getTime() + 100))).toBe(true);

    expect(
      message.scheduleRetry({
        now: occurredAt,
        baseDelayMs: 100,
        maxDelayMs: 350,
      }),
    ).toEqual(new Date(occurredAt.getTime() + 200));
    expect(
      message.scheduleRetry({
        now: occurredAt,
        baseDelayMs: 100,
        maxDelayMs: 350,
      }),
    ).toEqual(new Date(occurredAt.getTime() + 350));
    expect(message.attempts).toBe(3);
  });

  it('marks published messages terminal and clears scheduled retry state', () => {
    const message = create();
    message.scheduleRetry({ now: occurredAt, baseDelayMs: 100 });
    message.markPublished(occurredAt);

    expect(message.publishedAt).toEqual(occurredAt);
    expect(message.nextAttemptAt).toBeNull();
    expect(message.isPending(new Date(occurredAt.getTime() + 1000))).toBe(
      false,
    );
    expect(() => message.markPublished()).toThrow(
      'Outbox message has already been published',
    );
    expect(() => message.scheduleRetry()).toThrow(
      'A published outbox message cannot be retried',
    );
  });

  it('defensively copies payloads and dates', () => {
    const payload = { detail: { amount: '1.00' } };
    const message = OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload,
      occurredAt,
    });

    payload.detail.amount = 'mutated';
    const copy = message.payload;
    copy.detail!.amount = 'also-mutated';
    const date = message.occurredAt;
    date.setFullYear(2000);

    expect(message.payload.detail).toEqual({ amount: '1.00' });
    expect(message.occurredAt).toEqual(occurredAt);
  });

  it('clones nested arrays and objects in JSON payloads', () => {
    const message = OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { entries: [[{ amount: '1.00' }]] },
      occurredAt,
    });

    expect(message.payload).toEqual({ entries: [[{ amount: '1.00' }]] });
  });

  it('rejects values that cannot be represented as JSON', () => {
    const invalidValues: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol('payload'),
      () => 'payload',
      new Date(occurredAt),
    ];

    for (const value of invalidValues) {
      expect(() =>
        OutboxMessage.enqueue({
          id: 'event-1',
          aggregateId: 'wallet-1',
          eventType: 'WalletBalanceChanged',
          payload: { value },
          occurredAt,
        }),
      ).toThrow();
    }
  });

  it('rejects cycles in objects and nested arrays', () => {
    const cyclicObject: { self?: unknown } = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    for (const value of [cyclicObject, { nested: [cyclicArray] }]) {
      expect(() =>
        OutboxMessage.enqueue({
          id: 'event-1',
          aggregateId: 'wallet-1',
          eventType: 'WalletBalanceChanged',
          payload: { value },
          occurredAt,
        }),
      ).toThrow('Outbox payload cannot contain circular values');
    }
  });
});
