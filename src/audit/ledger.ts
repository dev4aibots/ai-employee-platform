/**
 * Hash-chained audit ledger.
 *
 * Every privileged action appends one entry. Each entry commits to its
 * predecessor:
 *
 *     entry_hash = sha256(prev_hash + "\n" + canonical_json(entry_without_hash))
 *
 * which gives three properties that matter to a security reviewer:
 *
 *   - Tampering is detectable. Editing entry 42 breaks 42 and every entry after
 *     it, and `verifyChain` reports the first index that fails.
 *   - Truncation is detectable, because the caller compares the chain head
 *     against the value stored in the database.
 *   - Writes are idempotent under retry, because the canonical form is stable
 *     (sorted keys, no floats in default positions, no locale-dependent output).
 */

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  userId: string | null;
  actor: string;
  action: string;
  subject?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface AuditEntry extends Required<Omit<AuditInput, 'subject'>> {
  seq: number;
  subject: string | null;
  prevHash: string;
  entryHash: string;
}

/**
 * Deterministic JSON: object keys sorted, arrays preserved, undefined dropped,
 * numbers rendered with Number#toString (no locale, no exponent surprises for
 * the integer range we use). Deliberately rejects non-finite numbers so a NaN
 * can never slip into a signed payload.
 */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): string => {
    if (input === null) return 'null';
    if (input === undefined) return 'null';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new Error('canonicalJson: non-finite number is not allowed in an audited payload');
      }
      return JSON.stringify(input);
    }
    if (typeof input === 'string' || typeof input === 'boolean') {
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) {
      return `[${input.map(walk).join(',')}]`;
    }
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${walk(v)}`).join(',')}}`;
    }
    throw new Error(`canonicalJson: unsupported type ${typeof input}`);
  };
  return walk(value);
}

export class AuditLedger {
  private readonly entries: AuditEntry[] = [];

  static hashEntry(entry: Omit<AuditEntry, 'entryHash'>): string {
    const material = [
      entry.prevHash,
      String(entry.seq),
      entry.userId ?? '',
      entry.actor,
      entry.action,
      entry.subject ?? '',
      canonicalJson(entry.payload),
      entry.createdAt,
    ].join('\n');
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }

  append(input: AuditInput): AuditEntry {
    const previous = this.entries.at(-1);
    const seq = previous ? previous.seq + 1 : 1;
    const prevHash = previous ? previous.entryHash : GENESIS_HASH;

    const withoutHash: Omit<AuditEntry, 'entryHash'> = {
      seq,
      userId: input.userId,
      actor: input.actor,
      action: input.action,
      subject: input.subject ?? null,
      payload: input.payload ?? {},
      prevHash,
      createdAt: input.createdAt ?? new Date(0).toISOString(),
    };

    const entry: AuditEntry = { ...withoutHash, entryHash: AuditLedger.hashEntry(withoutHash) };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  get head(): string {
    return this.entries.at(-1)?.entryHash ?? GENESIS_HASH;
  }

  static verifyChain(entries: readonly AuditEntry[]): { valid: boolean; brokenAt?: number; reason?: string } {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      if (entry.prevHash !== prevHash) {
        return { valid: false, brokenAt: i, reason: `entry ${i} does not point at its predecessor` };
      }
      const { entryHash, ...rest } = entry;
      const expected = AuditLedger.hashEntry(rest);
      if (expected !== entryHash) {
        return { valid: false, brokenAt: i, reason: `entry ${i} hash does not match its contents` };
      }
      prevHash = entryHash;
    }
    return { valid: true };
  }
}
