/**
 * Outbound dispatch to n8n with bounded retries and a circuit breaker.
 *
 * The failure this guards against is the one that actually takes these
 * platforms down: n8n is slow or down, the caller retries eagerly, and the
 * retries become the outage. So:
 *
 *   - Deliveries carry an idempotency key so n8n can de-duplicate.
 *   - Retries use exponential backoff with full jitter (avoids synchronised
 *     retry storms across tenants).
 *   - Only transient failures are retried. A 4xx means the payload is wrong and
 *     retrying it just burns quota, so it fails fast.
 *   - After N consecutive failures the breaker opens and calls short-circuit,
 *     which converts a slow dependency into an instant, observable rejection.
 *
 * Time and sleep are injected so the tests run in microseconds and are not
 * flaky on a loaded CI runner.
 */

import { signPayload } from '../crypto/hmac.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0 = no jitter, 1 = full jitter. */
  jitterRatio: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitterRatio: 1,
};

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  failureThreshold: number;
  openMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAtMs = 0;

  constructor(private readonly options: CircuitOptions) {}

  get currentState(): CircuitState {
    return this.state;
  }

  canAttempt(nowMs: number): boolean {
    if (this.state === 'open' && nowMs - this.openedAtMs >= this.options.openMs) {
      this.state = 'half_open';
      return true;
    }
    return this.state !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(nowMs: number): void {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = nowMs;
    }
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

/**
 * Exponential backoff with full jitter, clamped to maxDelayMs.
 * Deterministic given `rand`, so tests assert exact schedules.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY, rand: () => number = Math.random): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  if (policy.jitterRatio <= 0) return exponential;
  const jitter = exponential * policy.jitterRatio * rand();
  return Math.max(0, Math.round(exponential - jitter));
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export interface DispatchRequest {
  tenantId: string;
  employeeId: string;
  idempotencyKey: string;
  body: unknown;
}

export interface DispatchDeps {
  baseUrl: string;
  path: string;
  signingSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  policy?: RetryPolicy;
  circuit?: CircuitBreaker;
}

export interface DispatchResult {
  ok: boolean;
  attempts: number;
  status?: number;
  latencyMs: number;
  error?: string;
  circuitState: CircuitState;
  /** Set when the breaker refused the call without touching the network. */
  shortCircuited?: boolean;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function dispatchToN8n(request: DispatchRequest, deps: DispatchDeps): Promise<DispatchResult> {
  const policy = deps.policy ?? DEFAULT_RETRY;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const rand = deps.rand ?? Math.random;
  const circuit = deps.circuit ?? new CircuitBreaker({ failureThreshold: 5, openMs: 30_000 });

  const startedAt = now();
  const body = JSON.stringify(request.body);
  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    if (!circuit.canAttempt(now())) {
      return {
        ok: false,
        attempts: attempt,
        latencyMs: now() - startedAt,
        error: 'circuit_open',
        circuitState: circuit.currentState,
        shortCircuited: true,
      };
    }

    const timestamp = Math.floor(now() / 1000);
    const signature = signPayload(deps.signingSecret, timestamp, body);

    try {
      const response = await fetchImpl(`${deps.baseUrl}/${deps.path.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': request.idempotencyKey,
          'x-tenant-id': request.tenantId,
          'x-signature': signature,
          'x-timestamp': String(timestamp),
        },
        body,
      });

      if (response.ok) {
        circuit.recordSuccess();
        return {
          ok: true,
          attempts: attempt + 1,
          status: response.status,
          latencyMs: now() - startedAt,
          circuitState: circuit.currentState,
        };
      }

      lastStatus = response.status;
      lastError = `http_${response.status}`;

      if (!isTransientStatus(response.status)) {
        // Permanent failure: do not retry, do not trip the breaker (it is our bug).
        return {
          ok: false,
          attempts: attempt + 1,
          status: response.status,
          latencyMs: now() - startedAt,
          error: lastError,
          circuitState: circuit.currentState,
        };
      }

      circuit.recordFailure(now());
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'network_error';
      circuit.recordFailure(now());
    }

    const isLast = attempt === policy.maxAttempts - 1;
    if (!isLast) {
      await sleep(backoffDelay(attempt, policy, rand));
    }
  }

  return {
    ok: false,
    attempts: policy.maxAttempts,
    status: lastStatus,
    latencyMs: now() - startedAt,
    error: lastError ?? 'exhausted',
    circuitState: circuit.currentState,
  };
}
