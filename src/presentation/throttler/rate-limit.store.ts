import { Injectable } from '@nestjs/common';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private operationsSinceCleanup = 0;
  private readonly maxBuckets = 100_000;

  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): RateLimitDecision {
    if (
      !key ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1 ||
      !Number.isFinite(now)
    ) {
      throw new Error('Rate limit request is invalid');
    }

    if (++this.operationsSinceCleanup >= 256) {
      this.pruneExpired(now);
      this.operationsSinceCleanup = 0;
    }

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        this.pruneExpired(now);
      }
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAt: now + windowMs,
        };
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
