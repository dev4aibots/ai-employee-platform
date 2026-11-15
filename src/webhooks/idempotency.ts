/**
 * Webhook idempotency.
 *
 * Stripe and PayPal both retry. A naive handler emails the customer twice or
 * charges twice. The fix is a claim-first protocol:
 *
 *   1. Derive a stable idempotency key (provider + event id, or the caller's
 *      own key when the provider does not supply one).
 *   2. `INSERT ... ON CONFLICT DO NOTHING RETURNING`. One caller wins and owns
 *      the work; every replay gets zero rows back.
 *   3. If the same key arrives with a *different* body hash, that is not a
 *      retry — it is key reuse, which is either a provider bug or a tampered
 *      payload. Reject it loudly (409) instead of silently dropping it.
 *
 * The insert is a single statement, so it is atomic without an explicit
 * transaction and safe under concurrent delivery.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit/ledger.js';
import type { Queryable } from '../db/harness.js';

export type ClaimOutcome =
  | { status: 'claimed'; key: string }
  | { status: 'duplicate'; key: string; existingStatus: string; attempts: number }
  | { status: 'conflict'; key: string; reason: string };

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export function idempotencyKeyFor(provider: string, eventId: string): string {
  return `${provider}:${eventId}`;
}

export interface ClaimInput {
  provider: string;
  eventId: string;
  payload: unknown;
  /** Override the derived key, for providers that expose their own. */
  key?: string;
}

interface ReceiptRow {
  status: string;
  attempts: number;
  payload_sha256: string;
}

export class IdempotencyService {
  constructor(private readonly q: Queryable) {}

  async claim(input: ClaimInput): Promise<ClaimOutcome> {
    const key = input.key ?? idempotencyKeyFor(input.provider, input.eventId);
    const hash = payloadHash(input.payload);

    const inserted = await this.q.query<{ idempotency_key: string }>(
      `insert into webhook_receipts (idempotency_key, provider, event_id, payload_sha256, status, attempts)
       values ($1, $2, $3, $4, 'claimed', 1)
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [key, input.provider, input.eventId, hash],
    );

    if (inserted.rows.length === 1) {
      return { status: 'claimed', key };
    }

    const existing = await this.q.query<ReceiptRow>(
      `select status, attempts, payload_sha256 from webhook_receipts where idempotency_key = $1`,
      [key],
    );

    const row = existing.rows[0];
    if (!row) {
      // The row vanished between the insert and the read. Treat as retryable.
      return { status: 'conflict', key, reason: 'receipt_disappeared' };
    }

    if (row.payload_sha256 !== hash) {
      return {
        status: 'conflict',
        key,
        reason: 'idempotency key reused with a different payload',
      };
    }

    return {
      status: 'duplicate',
      key,
      existingStatus: row.status,
      attempts: row.attempts,
    };
  }

  async markProcessed(key: string, now: Date = new Date()): Promise<void> {
    await this.q.query(
      `update webhook_receipts set status = 'processed', processed_at = $2 where idempotency_key = $1`,
      [key, now.toISOString()],
    );
  }

  async markFailed(key: string, now: Date = new Date()): Promise<void> {
    await this.q.query(
      `update webhook_receipts set status = 'failed', processed_at = $2, attempts = attempts + 1 where idempotency_key = $1`,
      [key, now.toISOString()],
    );
  }

  async receipt(key: string): Promise<ReceiptRow | null> {
    const result = await this.q.query<ReceiptRow>(
      `select status, attempts, payload_sha256 from webhook_receipts where idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ?? null;
  }
}
