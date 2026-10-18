import { describe, expect, it } from 'bun:test';
import { correlationContext } from '../../../src/infrastructure/logging/correlation-context.js';
import { CorrelationMiddleware } from '../../../src/infrastructure/logging/correlation.middleware.js';
import { StructuredLogger } from '../../../src/infrastructure/logging/logger.service.js';

describe('correlation logging infrastructure', () => {
  it('preserves a valid incoming HTTP correlation id across async work', async () => {
    const middleware = new CorrelationMiddleware();
    const headers: Record<string, string> = {};
    let activeCorrelationId: string | undefined;
    const request = { headers: { 'x-correlation-id': 'request-trace-123' } };
    const response = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    };

    await new Promise<void>((resolve) => {
      middleware.use(request as never, response as never, () => {
        setTimeout(() => {
          activeCorrelationId = correlationContext.get()?.correlationId;
          resolve();
        }, 0);
      });
    });

    expect(activeCorrelationId).toBe('request-trace-123');
    expect(headers['X-Correlation-ID']).toBe('request-trace-123');
    expect(correlationContext.get()).toBeUndefined();
  });

  it('generates a UUID for absent or invalid headers', () => {
    const middleware = new CorrelationMiddleware();
    let generatedId: string | undefined;
    const response = { setHeader: (_name: string, value: string) => value };

    middleware.use(
      { headers: { 'x-correlation-id': 'invalid value' } } as never,
      response as never,
      () => {
        generatedId = correlationContext.get()?.correlationId;
      },
    );

    expect(generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('emits JSON logs with standardized tracing fields', () => {
    const logger = new StructuredLogger();
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };

    try {
      correlationContext.runWithCorrelationId(
        'logger-trace-123',
        () => {
          correlationContext.setAggregateId('wallet-123');
          logger.log('wallet updated', 'WalletService');
        },
        'wallet-123',
      );
    } finally {
      console.log = originalLog;
    }

    const record = JSON.parse(output[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'log',
      correlationId: 'logger-trace-123',
      aggregateId: 'wallet-123',
      context: 'WalletService',
      message: 'wallet updated',
    });
    expect(record.timestamp).toEqual(expect.any(String));
    expect(record.duration).toEqual(expect.any(Number));
  });
});
