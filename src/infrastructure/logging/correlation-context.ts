import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  correlationId: string;
  aggregateId?: string;
  startedAt: number;
}

class CorrelationContextStore {
  private readonly storage = new AsyncLocalStorage<CorrelationContext>();

  run<T>(context: CorrelationContext, callback: () => T): T {
    return this.storage.run({ ...context }, callback);
  }

  runWithCorrelationId<T>(
    correlationId: string,
    callback: () => T,
    aggregateId?: string,
  ): T {
    return this.run(
      {
        correlationId,
        ...(aggregateId ? { aggregateId } : {}),
        startedAt: Date.now(),
      },
      callback,
    );
  }

  get(): CorrelationContext | undefined {
    return this.storage.getStore();
  }

  setAggregateId(aggregateId: string): void {
    const context = this.storage.getStore();
    if (context) {
      context.aggregateId = aggregateId;
    }
  }
}

export const correlationContext = new CorrelationContextStore();
