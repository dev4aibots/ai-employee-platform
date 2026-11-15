import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../src/db/harness.js';
import { IdempotencyService, idempotencyKeyFor, payloadHash } from '../src/webhooks/idempotency.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

const PAYLOAD = { id: 'evt_123', type: 'checkout.session.completed', amount: 4900 };

describe('idempotency key derivation', () => {
  it('is stable for the same provider and event', () => {
    expect(idempotencyKeyFor('stripe', 'evt_123')).toBe('stripe:evt_123');
    expect(idempotencyKeyFor('stripe', 'evt_123')).toBe(idempotencyKeyFor('stripe', 'evt_123'));
  });

  it('differs across providers for the same event id', () => {
    expect(idempotencyKeyFor('stripe', 'evt_123')).not.toBe(idempotencyKeyFor('paypal', 'evt_123'));
  });

  it('hashes payloads canonically, so key order does not matter', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});

describe('claim protocol', () => {
  it('claims a fresh event exactly once', async () => {
    const first = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      return svc.claim({ provider: 'stripe', eventId: 'evt_first', payload: PAYLOAD });
    });
    expect(first).toMatchObject({ status: 'claimed', key: 'stripe:evt_first' });
  });

  it('marks a replay as a duplicate instead of reprocessing it', async () => {
    const results = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      const a = await svc.claim({ provider: 'stripe', eventId: 'evt_dup', payload: PAYLOAD });
      const b = await svc.claim({ provider: 'stripe', eventId: 'evt_dup', payload: PAYLOAD });
      const c = await svc.claim({ provider: 'stripe', eventId: 'evt_dup', payload: PAYLOAD });
      return [a.status, b.status, c.status];
    });
    expect(results).toEqual(['claimed', 'duplicate', 'duplicate']);
  });

  it('rejects key reuse with a different payload', async () => {
    const outcome = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      await svc.claim({ provider: 'stripe', eventId: 'evt_reuse', payload: PAYLOAD });
      return svc.claim({
        provider: 'stripe',
        eventId: 'evt_reuse',
        payload: { ...PAYLOAD, amount: 1 },
      });
    });
    expect(outcome.status).toBe('conflict');
  });

  it('survives concurrent duplicate delivery', async () => {
    const statuses = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          svc.claim({ provider: 'paypal', eventId: 'evt_race', payload: PAYLOAD }),
        ),
      );
      return attempts.map((a) => a.status);
    });

    expect(statuses.filter((s) => s === 'claimed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(7);
  });
});

describe('receipt state machine', () => {
  it('records processed state and keeps the duplicate path honest', async () => {
    const outcome = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      const claim = await svc.claim({ provider: 'stripe', eventId: 'evt_state', payload: PAYLOAD });
      const key = claim.status === 'claimed' ? claim.key : 'stripe:evt_state';
      await svc.markProcessed(key, new Date('2026-11-15T10:00:00.000Z'));
      const replay = await svc.claim({ provider: 'stripe', eventId: 'evt_state', payload: PAYLOAD });
      return { replay, receipt: await svc.receipt(key) };
    });

    expect(outcome.replay).toMatchObject({ status: 'duplicate', existingStatus: 'processed' });
    expect(outcome.receipt?.status).toBe('processed');
  });

  it('records a failure and increments attempts so a retry is visible', async () => {
    const receipt = await h.asService(async (q) => {
      const svc = new IdempotencyService(q);
      const claim = await svc.claim({ provider: 'stripe', eventId: 'evt_fail', payload: PAYLOAD });
      const key = claim.status === 'claimed' ? claim.key : 'stripe:evt_fail';
      await svc.markFailed(key);
      return svc.receipt(key);
    });

    expect(receipt).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('returns null for an unknown key', async () => {
    const receipt = await h.asService(async (q) =>
      new IdempotencyService(q).receipt('stripe:never-seen'),
    );
    expect(receipt).toBeNull();
  });
});
