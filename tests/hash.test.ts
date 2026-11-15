import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../src/util/sha256.js';
import { sha256Hex } from '../src/util/hash.js';

/**
 * The pipeline's content hashes, approval chain and idempotency keys all rest
 * on this digest, and it runs in the browser where `node:crypto` does not
 * exist. A hand-written SHA-256 is only defensible if it is verified against
 * both the standard vectors and the platform implementation, so both are here.
 */

const NIST_VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

/** Deterministic pseudo-random ASCII, so a failure is reproducible. */
function sample(length: number, seed = 0x9e3779b9): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out += String.fromCharCode(32 + (state % 95));
  }
  return out;
}

function nodeDigest(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('sha256', () => {
  it('matches the published NIST vectors', () => {
    for (const [input, expected] of NIST_VECTORS) {
      expect(sha256Hex(input), `digest of ${JSON.stringify(input.slice(0, 16))}`).toBe(expected);
    }
  });

  it('produces 32 bytes as lowercase hex', () => {
    expect(sha256Bytes(new TextEncoder().encode('abc'))).toHaveLength(32);
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agrees with node:crypto across padding boundaries', () => {
    // 55/56 and 63/64 are where the length field forces an extra block.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const input = sample(length);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeDigest(input));
    }
  });

  it('agrees with node:crypto on arbitrary inputs', () => {
    for (let length = 0; length <= 200; length += 7) {
      const input = sample(length, length + 1);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeDigest(input));
    }
  });

  it('agrees with node:crypto on multi-block inputs', () => {
    for (const length of [1_000, 4_096, 65_536, 100_000]) {
      const input = sample(length, length);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeDigest(input));
    }
  });

  it('handles non-ASCII input by encoding UTF-8 first', () => {
    for (const input of ['héllo', '🌍', 'नमस्ते', 'a🌍b'.repeat(20)]) {
      expect(sha256Hex(input)).toBe(nodeDigest(input));
    }
  });

  it('is sensitive to a single character', () => {
    expect(sha256Hex('a'.repeat(64))).not.toBe(sha256Hex(`${'a'.repeat(63)}b`));
  });
});
