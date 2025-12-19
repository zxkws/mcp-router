import type { AuthedPrincipal } from './types.js';

type Bucket = {
  tokens: number;
  updatedAtMs: number;
  capacity: number;
  refillPerMs: number;
};

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(principal: AuthedPrincipal) {
    if (!principal.enabled) return;
    const rpm = principal.rateLimitRpm;
    if (!rpm || rpm <= 0) return;

    const now = Date.now();
    const key = principal.token;
    const capacity = rpm;
    const refillPerMs = rpm / 60_000;

    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? {
      tokens: capacity,
      updatedAtMs: now,
      capacity,
      refillPerMs,
    };

    // Refill
    const elapsed = Math.max(0, now - bucket.updatedAtMs);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.updatedAtMs = now;
    bucket.capacity = capacity;
    bucket.refillPerMs = refillPerMs;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
      const err = new Error(`Rate limit exceeded (retry after ~${retryAfterSeconds}s)`);
      (err as any).code = 'RATE_LIMIT';
      throw err;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
  }
}

