export type IntegrationEventData =
  | string
  | number
  | boolean
  | null
  | readonly IntegrationEventData[]
  | { readonly [key: string]: IntegrationEventData | undefined };

type DeepReadonly<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface IntegrationEventMetadata {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventJSON<T extends IntegrationEventData> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  eventType: string;
  data: DeepReadonly<T>;
}

function assertJsonCompatible(
  data: unknown,
  ancestors = new WeakSet<object>(),
): asserts data is IntegrationEventData {
  if (data === null || typeof data === 'string' || typeof data === 'boolean') {
    return;
  }
  if (typeof data === 'number') {
    if (!Number.isFinite(data)) {
      throw new TypeError('Integration event data must contain finite numbers');
    }
    return;
  }
  if (typeof data !== 'object') {
    throw new TypeError('Integration event data must be JSON-compatible');
  }
  if (ancestors.has(data)) {
    throw new TypeError(
      'Integration event data cannot contain circular values',
    );
  }
  ancestors.add(data);
  if (Array.isArray(data)) {
    for (const item of data) {
      assertJsonCompatible(item, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        'Integration event data must use plain JSON-compatible objects',
      );
    }
    if (Object.getOwnPropertySymbols(data).length > 0) {
      throw new TypeError('Integration event data cannot contain symbol keys');
    }
    for (const value of Object.values(data)) {
      if (value === undefined) {
        throw new TypeError(
          'Integration event data cannot contain undefined values',
        );
      }
      assertJsonCompatible(value, ancestors);
    }
  }
  ancestors.delete(data);
}

function deepFreezeData<T>(data: T): T {
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (value !== undefined) {
        deepFreezeData(value);
      }
    }
    Object.freeze(data);
  }
  return data;
}

export abstract class IntegrationEvent<T extends IntegrationEventData> {
  readonly eventType: string;
  readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  private readonly _occurredAt: Date;
  readonly data: DeepReadonly<T>;

  protected constructor(
    eventType: string,
    version: number,
    metadata: IntegrationEventMetadata,
    data: T,
  ) {
    if (
      !eventType.trim() ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !metadata.eventId.trim() ||
      !metadata.aggregateId.trim() ||
      !metadata.correlationId.trim() ||
      (metadata.causationId !== undefined && !metadata.causationId.trim()) ||
      Number.isNaN(metadata.occurredAt.getTime())
    ) {
      throw new TypeError('Integration event metadata is invalid');
    }
    this.eventType = eventType;
    this.version = version;
    this.eventId = metadata.eventId;
    this.aggregateId = metadata.aggregateId;
    this.correlationId = metadata.correlationId;
    this.causationId = metadata.causationId;
    this._occurredAt = new Date(metadata.occurredAt);
    assertJsonCompatible(data);
    this.data = deepFreezeData(structuredClone(data)) as DeepReadonly<T>;
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  toJSON(): IntegrationEventJSON<T> {
    const envelope: IntegrationEventJSON<T> = {
      eventId: this.eventId,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      eventType: this.eventType,
      data: structuredClone(this.data),
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}
