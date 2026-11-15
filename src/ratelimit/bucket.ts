/**
 * Token bucket rate limiting with an injected clock.
 *
 * Used for two things in this platform: protecting the n8n webhook from a
 * runaway agent loop, and protecting per-tenant model spend. Both need a limit
 * that is deterministic in tests, hence no `Date.now()` inside.
 */

export interface BucketOptions {
  capacity: number;
  refillPerSecond: number;
  /** Optional burst allowance on top of capacity. Defaults to 0. */
  burst?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until enough tokens exist for the rejected request. */
  retryAfterMs: number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: BucketOptions, nowMs: number = 0) {
    if (options.capacity <= 0) throw new Error('capacity must be > 0');
    if (options.refillPerSecond <= 0) throw new Error('refillPerSecond must be > 0');
    this.capacity = options.capacity + (options.burst ?? 0);
    this.refillPerSecond = options.refillPerSecond;
    this.tokens = this.capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = nowMs;
  }

  tryConsume(cost = 1, nowMs = this.lastRefillMs): ConsumeResult {
    this.refill(nowMs);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: this.tokens, retryAfterMs: 0 };
    }
    const deficit = cost - this.tokens;
    return {
      allowed: false,
      remaining: this.tokens,
      retryAfterMs: Math.ceil((deficit / this.refillPerSecond) * 1000),
    };
  }

  get available(): number {
    return this.tokens;
  }
}

/** Per-tenant bucket registry, so one noisy tenant cannot starve another. */
export class TenantRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly options: BucketOptions) {}

  consume(tenantId: string, cost: number, nowMs: number): ConsumeResult {
    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      bucket = new TokenBucket(this.options, nowMs);
      this.buckets.set(tenantId, bucket);
    }
    return bucket.tryConsume(cost, nowMs);
  }

  trackedTenants(): number {
    return this.buckets.size;
  }
}
