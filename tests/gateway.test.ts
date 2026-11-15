import { describe, expect, it, vi } from 'vitest';
import { verifySignature } from '../src/crypto/hmac.js';
import {
  backoffDelay,
  CircuitBreaker,
  DEFAULT_RETRY,
  dispatchToN8n,
  isTransientStatus,
  type DispatchDeps,
} from '../src/gateway/n8n.js';

const BASE: Omit<DispatchDeps, 'fetchImpl'> = {
  baseUrl: 'https://n8n.internal',
  path: 'webhook/master',
  signingSecret: 'dispatch-secret',
  sleep: async () => {},
  rand: () => 0,
};

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

const REQUEST = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  employeeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  idempotencyKey: 'tenant-a:evt_1',
  body: { message: 'hello' },
};

describe('backoff', () => {
  it('doubles exponentially with no jitter', () => {
    const policy = { ...DEFAULT_RETRY, jitterRatio: 0 };
    expect(backoffDelay(0, policy)).toBe(200);
    expect(backoffDelay(1, policy)).toBe(400);
    expect(backoffDelay(2, policy)).toBe(800);
    expect(backoffDelay(3, policy)).toBe(1_600);
  });

  it('clamps at maxDelayMs', () => {
    const policy = { ...DEFAULT_RETRY, jitterRatio: 0, maxDelayMs: 1_000 };
    expect(backoffDelay(10, policy)).toBe(1_000);
  });

  it('subtracts jitter deterministically', () => {
    const policy = { ...DEFAULT_RETRY, jitterRatio: 1 };
    expect(backoffDelay(0, policy, () => 0)).toBe(200);
    expect(backoffDelay(0, policy, () => 1)).toBe(0);
    expect(backoffDelay(0, policy, () => 0.5)).toBe(100);
  });

  it('never returns a negative delay', () => {
    expect(backoffDelay(0, { ...DEFAULT_RETRY, jitterRatio: 2 }, () => 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('transient status classification', () => {
  it('retries only failures that can plausibly succeed later', () => {
    expect([408, 425, 429, 500, 502, 503, 504].every(isTransientStatus)).toBe(true);
    expect([400, 401, 403, 404, 409, 422].some(isTransientStatus)).toBe(false);
  });
});

describe('dispatch outcomes', () => {
  it('returns success on the first attempt', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const result = await dispatchToN8n(REQUEST, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ ok: true, attempts: 1, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const result = await dispatchToN8n(REQUEST, { ...BASE, fetchImpl });

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 because the payload will never become valid', async () => {
    const fetchImpl = vi.fn(async () => response(400));
    const result = await dispatchToN8n(REQUEST, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ ok: false, attempts: 1, status: 400, error: 'http_400' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exhausts attempts on a persistent 500', async () => {
    const fetchImpl = vi.fn(async () => response(500));
    const result = await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 3 },
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reports a network error rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 2 },
    });

    expect(result).toMatchObject({ ok: false, error: 'ECONNREFUSED', attempts: 2 });
  });
});

describe('circuit breaker', () => {
  it('opens after the failure threshold and short-circuits without a network call', async () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, openMs: 30_000 });
    const failing = vi.fn(async () => response(500));

    const first = await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: failing as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 1 },
      circuit,
      now: () => 1_000,
    });
    expect(first.ok).toBe(false);
    expect(circuit.currentState).toBe('open');

    const callsBefore = failing.mock.calls.length;
    const second = await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: failing as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 1 },
      circuit,
      now: () => 2_000,
    });

    expect(second.shortCircuited).toBe(true);
    expect(second.error).toBe('circuit_open');
    expect(failing.mock.calls.length).toBe(callsBefore);
  });

  it('half-opens after the cooldown and closes on a success', async () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000 });
    const failing = vi.fn(async () => response(500));

    await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: failing as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 1 },
      circuit,
      now: () => 0,
    });
    expect(circuit.currentState).toBe('open');

    const recovering = vi.fn(async () => response(200));
    const probe = await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: recovering as unknown as typeof fetch,
      policy: { ...DEFAULT_RETRY, maxAttempts: 1 },
      circuit,
      now: () => 1_500,
    });

    expect(probe.ok).toBe(true);
    expect(circuit.currentState).toBe('closed');
    expect(circuit.consecutiveFailures).toBe(0);
  });
});

describe('request contract', () => {
  it('sends an idempotency key, tenant header and a verifiable signature', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return response(200);
    });

    await dispatchToN8n(REQUEST, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_760_000_000_000,
    });

    const headers = captured!.init.headers as Record<string, string>;
    const body = captured!.init.body as string;

    expect(captured!.url).toBe('https://n8n.internal/webhook/master');
    expect(headers['x-idempotency-key']).toBe('tenant-a:evt_1');
    expect(headers['x-tenant-id']).toBe(REQUEST.tenantId);

    const verified = verifySignature({
      secret: BASE.signingSecret,
      body,
      signature: headers['x-signature'],
      timestamp: headers['x-timestamp'],
      toleranceSeconds: 300,
      now: 1_760_000_000_000,
    });
    expect(verified.ok).toBe(true);
  });
});
