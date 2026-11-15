import { describe, expect, it } from 'vitest';
import { AuditLedger, canonicalJson, GENESIS_HASH, type AuditEntry } from '../src/audit/ledger.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function sampleLedger(size = 3): AuditLedger {
  const ledger = new AuditLedger();
  for (let i = 0; i < size; i += 1) {
    ledger.append({
      userId: TENANT,
      actor: 'ops@acme.test',
      action: 'employee.deploy',
      subject: `employee-${i}`,
      payload: { index: i },
      createdAt: `2026-11-15T10:0${i}:00.000Z`,
    });
  }
  return ledger;
}

describe('canonical json', () => {
  it('sorts object keys so key order cannot change a hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('preserves array order because order is semantic', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('handles nesting and null', () => {
    expect(canonicalJson({ z: [ { b: null, a: true } ] })).toBe('{"z":[{"a":true,"b":null}]}');
  });

  it('drops undefined members instead of emitting invalid json', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses non-finite numbers so NaN cannot silently enter a signed payload', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});

describe('chain construction', () => {
  it('starts from the genesis hash and numbers entries from one', () => {
    const ledger = sampleLedger(1);
    const entry = ledger.all()[0]!;
    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(entry.entryHash).toHaveLength(64);
  });

  it('links each entry to its predecessor', () => {
    const entries = sampleLedger(4).all();
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.prevHash).toBe(entries[i - 1]!.entryHash);
    }
  });

  it('reports the head hash', () => {
    const ledger = sampleLedger(2);
    expect(ledger.head).toBe(ledger.all()[1]!.entryHash);
  });

  it('produces a different hash when any field changes', () => {
    const a = new AuditLedger().append({ userId: TENANT, actor: 'x', action: 'y' });
    const b = new AuditLedger().append({ userId: TENANT, actor: 'x', action: 'z' });
    expect(a.entryHash).not.toBe(b.entryHash);
  });
});

describe('tamper detection', () => {
  it('accepts an untouched chain', () => {
    expect(AuditLedger.verifyChain(sampleLedger(5).all())).toEqual({ valid: true });
  });

  it('detects an edited payload', () => {
    const entries = [...sampleLedger(4).all()] as AuditEntry[];
    entries[2] = { ...entries[2]!, payload: { index: 99 } };
    const result = AuditLedger.verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('detects a deleted entry, because the following prev_hash no longer matches', () => {
    const entries = [...sampleLedger(4).all()] as AuditEntry[];
    entries.splice(1, 1);
    const result = AuditLedger.verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('detects a re-ordered pair', () => {
    const entries = [...sampleLedger(4).all()] as AuditEntry[];
    const swapped = [entries[0]!, entries[2]!, entries[1]!, entries[3]!];
    expect(AuditLedger.verifyChain(swapped).valid).toBe(false);
  });

  it('detects a fully rewritten hash', () => {
    const entries = [...sampleLedger(3).all()] as AuditEntry[];
    entries[1] = { ...entries[1]!, entryHash: 'f'.repeat(64) };
    expect(AuditLedger.verifyChain(entries).valid).toBe(false);
  });

  it('exposes truncation via the head hash', () => {
    const full = sampleLedger(5);
    const truncated = full.all().slice(0, 3);
    // A truncated chain is internally consistent, which is exactly why the head
    // hash must also be published and compared out of band.
    expect(AuditLedger.verifyChain(truncated).valid).toBe(true);
    expect(truncated.at(-1)!.entryHash).not.toBe(full.head);
  });
});
