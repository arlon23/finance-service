import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';

function cloneJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Outbox payload must contain only JSON-compatible values',
    );
  }
  if (ancestors.has(value)) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Outbox payload cannot contain circular values',
    );
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (!isArray && prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Outbox payload must contain only plain JSON objects and arrays',
    );
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new DomainError(
          FailureCode.INVALID_PAYLOAD,
          'Outbox payload arrays must not contain holes or custom properties',
        );
      }
      return value.map((item) => cloneJsonValue(item, ancestors));
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new DomainError(
          FailureCode.INVALID_PAYLOAD,
          'Outbox payload cannot contain accessor properties',
        );
      }
      result[key] = cloneJsonValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const copy = cloneJsonValue(value);
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new DomainError(
      FailureCode.INVALID_PAYLOAD,
      'Outbox payload must be a plain JSON object',
    );
  }
  return Object.fromEntries(Object.entries(copy));
}

export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export interface OutboxMessageState extends OutboxMessageProps {
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export interface OutboxRetryPolicy {
  now?: Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class OutboxMessage {
  private _attempts: number;
  private _nextAttemptAt: Date | null;
  private _publishedAt: Date | null;
  private readonly _occurredAt: Date;
  private readonly _payload: Record<string, unknown>;

  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    payload: Record<string, unknown>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date | null,
    publishedAt: Date | null,
  ) {
    this._payload = cloneJsonObject(payload);
    this._occurredAt = new Date(occurredAt);
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt ? new Date(nextAttemptAt) : null;
    this._publishedAt = publishedAt ? new Date(publishedAt) : null;
  }

  static enqueue(props: OutboxMessageProps): OutboxMessage {
    if (
      !props ||
      !props.id?.trim() ||
      !props.aggregateId?.trim() ||
      !props.eventType?.trim() ||
      !props.payload ||
      typeof props.payload !== 'object' ||
      Array.isArray(props.payload)
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Outbox message requires identifiers and a JSON object payload',
      );
    }
    const occurredAt = props.occurredAt ?? new Date();
    const attempts = props.attempts ?? 0;
    if (
      Number.isNaN(occurredAt.getTime()) ||
      (props.nextAttemptAt != null &&
        Number.isNaN(props.nextAttemptAt.getTime())) ||
      (props.publishedAt != null &&
        Number.isNaN(props.publishedAt.getTime())) ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Outbox message timestamp or attempt count is invalid',
      );
    }
    return new OutboxMessage(
      props.id,
      props.aggregateId,
      props.eventType,
      props.payload,
      occurredAt,
      attempts,
      props.nextAttemptAt ?? null,
      props.publishedAt ?? null,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get payload(): Record<string, unknown> {
    return structuredClone(this._payload);
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : null;
  }

  get publishedAt(): Date | null {
    return this._publishedAt ? new Date(this._publishedAt) : null;
  }

  isPending(now = new Date()): boolean {
    return (
      this._publishedAt === null &&
      (this._nextAttemptAt === null || this._nextAttemptAt <= now)
    );
  }

  markPublished(publishedAt = new Date()): void {
    if (this._publishedAt) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Outbox message has already been published',
      );
    }
    if (Number.isNaN(publishedAt.getTime())) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Published timestamp is invalid',
      );
    }
    this._publishedAt = new Date(publishedAt);
    this._nextAttemptAt = null;
  }

  scheduleRetry(policy: OutboxRetryPolicy = {}): Date {
    if (this._publishedAt) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'A published outbox message cannot be retried',
      );
    }
    const now = policy.now ?? new Date();
    const baseDelayMs = policy.baseDelayMs ?? 1_000;
    const maxDelayMs = policy.maxDelayMs ?? 300_000;
    if (
      Number.isNaN(now.getTime()) ||
      !Number.isSafeInteger(baseDelayMs) ||
      !Number.isSafeInteger(maxDelayMs) ||
      baseDelayMs < 1 ||
      maxDelayMs < baseDelayMs
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Outbox retry policy is invalid',
      );
    }
    this._attempts += 1;
    const exponent = Math.min(this._attempts - 1, 52);
    const delay = Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    return new Date(this._nextAttemptAt);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt,
      publishedAt: this.publishedAt,
    };
  }
}
