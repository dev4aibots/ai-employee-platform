import { describe, expect, it } from 'vitest';
import { TenantRateLimiter, TokenBucket } from '../src/ratelimit/bucket.js';

describe('token bucket', () => {
  it('allows exactly capacity requests', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, 0);
    expect(bucket.tryConsume(1, 0).allowed).toBe(true);
    expect(bucket.tryConsume(1, 0).allowed).toBe(true);
    expect(bucket.tryConsume(1, 0).allowed).toBe(true);
    const rejected = bucket.tryConsume(1, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills at the configured rate', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 }, 0);
    bucket.tryConsume(2, 0);
    expect(bucket.tryConsume(1, 0).allowed).toBe(false);

    // 2 tokens/s -> one token after 500ms
    expect(bucket.tryConsume(1, 500).allowed).toBe(true);
    expect(bucket.tryConsume(1, 500).allowed).toBe(false);
  });

  it('never exceeds capacity when idle for a long time', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 100 }, 0);
    bucket.tryConsume(5, 0);
    // refill clamps at capacity, so at most capacity calls succeed even after a
    // long idle period
    let allowed = 0;
    for (let i = 0; i < 10; i += 1) {
      if (bucket.tryConsume(1, 60_000).allowed) allowed += 1;
    }
    expect(allowed).toBe(5);
  });

  it('supports weighted costs', () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1 }, 0);
    expect(bucket.tryConsume(8, 0).allowed).toBe(true);
    expect(bucket.tryConsume(8, 0).allowed).toBe(false);
    expect(bucket.tryConsume(2, 0).allowed).toBe(true);
  });

  it('computes retryAfterMs from the deficit', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.5 }, 0);
    bucket.tryConsume(1, 0);
    const result = bucket.tryConsume(1, 0);
    expect(result.retryAfterMs).toBe(2000);
  });

  it('adds burst allowance on top of capacity', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, burst: 3 }, 0);
    expect(bucket.capacity).toBe(5);
  });

  it('rejects nonsensical configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(/capacity/);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(/refillPerSecond/);
  });
});

describe('per-tenant isolation', () => {
  it('keeps one tenant from exhausting another', () => {
    const limiter = new TenantRateLimiter({ capacity: 2, refillPerSecond: 1 });

    expect(limiter.consume('tenant-a', 1, 0).allowed).toBe(true);
    expect(limiter.consume('tenant-a', 1, 0).allowed).toBe(true);
    expect(limiter.consume('tenant-a', 1, 0).allowed).toBe(false);

    // tenant-b is untouched
    expect(limiter.consume('tenant-b', 1, 0).allowed).toBe(true);
    expect(limiter.trackedTenants()).toBe(2);
  });
});
