import { describe, expect, it } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RateLimit } from '../../src/presentation/throttler/rate-limit.decorator.js';
import { RateLimitGuard } from '../../src/presentation/throttler/rate-limit.guard.js';
import { RateLimitStore } from '../../src/presentation/throttler/rate-limit.store.js';

class RateLimitedController {
  @RateLimit({ limit: 2, windowMs: 60_000, identity: 'wager' })
  wager(this: void): void {}

  @RateLimit({ limit: 1, windowMs: 60_000, identity: 'wallet' })
  wallet(this: void): void {}
}

function invokeGuard(
  guard: RateLimitGuard,
  handler: (...args: never[]) => unknown,
  request: Partial<Request>,
): Map<string, string> {
  const headers = new Map<string, string>();
  const context = {
    getHandler: () => handler,
    getClass: () => RateLimitedController,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () =>
        ({
          setHeader: (name: string, value: string) => headers.set(name, value),
        }) as Response,
    }),
  };
  guard.canActivate(context as never);
  return headers;
}

describe('RateLimitGuard', () => {
  it('limits wagers by provider, player, and client address with response headers', () => {
    const guard = new RateLimitGuard(new Reflector(), new RateLimitStore());
    const request = {
      body: { providerId: 'provider-1', playerId: 'player-1' },
      ip: '192.0.2.1',
      headers: {},
    } as Partial<Request>;

    expect(
      invokeGuard(guard, RateLimitedController.prototype.wager, request),
    ).toEqual(
      new Map([
        ['X-RateLimit-Limit', '2'],
        ['X-RateLimit-Remaining', '1'],
      ]),
    );
    expect(
      invokeGuard(guard, RateLimitedController.prototype.wager, request),
    ).toEqual(
      new Map([
        ['X-RateLimit-Limit', '2'],
        ['X-RateLimit-Remaining', '0'],
      ]),
    );
    expect(
      invokeGuard(guard, RateLimitedController.prototype.wager, {
        ...request,
        body: { providerId: 'provider-1', playerId: 'player-2' },
      }),
    ).toEqual(
      new Map([
        ['X-RateLimit-Limit', '2'],
        ['X-RateLimit-Remaining', '1'],
      ]),
    );

    const responseHeaders = new Map<string, string>();
    const limitedContext = {
      getHandler: () => RateLimitedController.prototype.wager,
      getClass: () => RateLimitedController,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () =>
          ({
            setHeader: (name: string, value: string) =>
              responseHeaders.set(name, value),
          }) as Response,
      }),
    };
    try {
      guard.canActivate(limitedContext as never);
      throw new Error('Expected request to be rate limited');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        statusCode: 429,
        errorCode: 'RATE_LIMIT_EXCEEDED',
      });
    }
    expect(responseHeaders.get('X-RateLimit-Limit')).toBe('2');
    expect(responseHeaders.get('X-RateLimit-Remaining')).toBe('0');
    expect(Number(responseHeaders.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('isolates wallet credentials and client addresses', () => {
    const guard = new RateLimitGuard(new Reflector(), new RateLimitStore());
    const firstHeaders = invokeGuard(
      guard,
      RateLimitedController.prototype.wallet,
      {
        ip: '192.0.2.1',
        headers: { 'x-api-key': 'secret-one' },
      } as Partial<Request>,
    );
    const otherCredentialHeaders = invokeGuard(
      guard,
      RateLimitedController.prototype.wallet,
      {
        ip: '192.0.2.1',
        headers: { 'x-api-key': 'secret-two' },
      } as Partial<Request>,
    );
    const otherAddressHeaders = invokeGuard(
      guard,
      RateLimitedController.prototype.wallet,
      {
        ip: '192.0.2.2',
        headers: { 'x-api-key': 'secret-one' },
      } as Partial<Request>,
    );

    expect(firstHeaders.get('X-RateLimit-Remaining')).toBe('0');
    expect(otherCredentialHeaders.get('X-RateLimit-Remaining')).toBe('0');
    expect(otherAddressHeaders.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('resets expired fixed-window buckets and rejects invalid policies', () => {
    const store = new RateLimitStore();
    expect(store.consume('bucket', 1, 1_000, 10_000).allowed).toBe(true);
    expect(store.consume('bucket', 1, 1_000, 10_500).allowed).toBe(false);
    expect(store.consume('bucket', 1, 1_000, 11_000).allowed).toBe(true);
    expect(() => store.consume('bucket', 0, 1_000, 11_000)).toThrow(
      'Rate limit request is invalid',
    );
  });
});
