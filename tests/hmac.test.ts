import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/crypto/hmac.js';

const SECRET = 'whsec_test_shared_secret';
const BODY = JSON.stringify({ id: 'evt_1', amount: 4900 });
const NOW = 1_760_000_000_000; // fixed clock, ms

function signed(timestampSeconds: number, body = BODY) {
  return signPayload(SECRET, timestampSeconds, body);
}

describe('webhook signature verification', () => {
  it('accepts a freshly signed body', () => {
    const ts = Math.floor(NOW / 1000);
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signed(ts),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.skewSeconds).toBe(0);
  });

  it('rejects a body that changed after signing', () => {
    const ts = Math.floor(NOW / 1000);
    const result = verifySignature({
      secret: SECRET,
      body: BODY.replace('4900', '1'),
      signature: signed(ts),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const ts = Math.floor(NOW / 1000);
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signPayload('wrong-secret', ts, BODY),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a replay older than the tolerance window', () => {
    const ts = Math.floor(NOW / 1000) - 301;
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signed(ts),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    expect(result.skewSeconds).toBe(301);
  });

  it('accepts a replay inside the tolerance window', () => {
    const ts = Math.floor(NOW / 1000) - 299;
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signed(ts),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a timestamp from the far future (clock skew attack)', () => {
    const ts = Math.floor(NOW / 1000) + 600;
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signed(ts),
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts a millisecond timestamp because providers are inconsistent', () => {
    const tsMs = NOW - 1_000;
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: signPayload(SECRET, tsMs, BODY),
      timestamp: tsMs,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('reports missing inputs distinctly', () => {
    const base = { secret: SECRET, body: BODY, toleranceSeconds: 300, now: NOW };
    expect(verifySignature({ ...base, signature: null, timestamp: 1 })).toMatchObject({
      reason: 'missing_signature',
    });
    expect(verifySignature({ ...base, signature: 'abc', timestamp: null })).toMatchObject({
      reason: 'missing_timestamp',
    });
    expect(verifySignature({ ...base, signature: 'abc', timestamp: 'yesterday' })).toMatchObject({
      reason: 'bad_timestamp',
    });
  });

  it('rejects a signature of the right shape but wrong length', () => {
    const ts = Math.floor(NOW / 1000);
    const result = verifySignature({
      secret: SECRET,
      body: BODY,
      signature: 'abcd',
      timestamp: ts,
      toleranceSeconds: 300,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });
});
