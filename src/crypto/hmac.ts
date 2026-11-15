/**
 * Inbound webhook signature verification.
 *
 * Two failure modes matter for a paid platform:
 *
 *  1. Replay. A valid signed body captured off the wire can be re-sent forever.
 *     Solved by requiring a timestamp inside the signature and rejecting
 *     anything older than the tolerance window. Idempotency keys (see
 *     src/webhooks/idempotency.ts) then make retries inside the window harmless.
 *  2. Timing attack. Comparing signatures with === leaks how many bytes matched.
 *     Solved with timingSafeEqual on equal-length buffers.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'signature_mismatch';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  /** Signed clock skew in seconds. Negative when the timestamp is in the future. */
  skewSeconds?: number;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  if (!secret) throw new Error('signing secret is required');
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface VerifyOptions {
  secret: string;
  body: string;
  signature: string | null | undefined;
  timestamp: string | number | null | undefined;
  toleranceSeconds: number;
  now?: number;
}

export function verifySignature(options: VerifyOptions): VerifyResult {
  const { secret, body, signature, timestamp, toleranceSeconds } = options;
  const now = options.now ?? Date.now();

  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return { ok: false, reason: 'missing_timestamp' };
  }

  const ts = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };

  // Providers may send either epoch seconds or milliseconds. Normalise.
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  const skewSeconds = Math.round((now - tsMs) / 1000);

  if (Math.abs(skewSeconds) > toleranceSeconds) {
    return { ok: false, reason: 'stale_timestamp', skewSeconds };
  }

  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const provided = signature.trim().toLowerCase();

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');

  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'signature_mismatch', skewSeconds };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'signature_mismatch', skewSeconds };
  }

  return { ok: true, skewSeconds };
}
