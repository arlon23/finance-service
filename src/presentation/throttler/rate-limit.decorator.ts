import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_METADATA = 'financial-service:rate-limit';

export type RateLimitIdentity = 'wallet' | 'wager';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  identity: RateLimitIdentity;
}

export function RateLimit(options: RateLimitOptions): MethodDecorator {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isSafeInteger(options.windowMs) ||
    options.windowMs < 1
  ) {
    throw new Error('Rate limit options must be positive safe integers');
  }
  return SetMetadata(RATE_LIMIT_METADATA, Object.freeze({ ...options }));
}
