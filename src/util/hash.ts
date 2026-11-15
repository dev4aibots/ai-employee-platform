import { sha256Bytes } from './sha256.js';

/**
 * Hashing helpers shared by the Node tests and the browser demo.
 *
 * `node:crypto` is not available in the browser and the demo runs this exact
 * code rather than a reimplementation of it, so the digest comes from
 * `src/util/sha256.ts`: standard SHA-256, verified against NIST vectors and
 * cross-checked against `node:crypto` in `tests/hash.test.ts`.
 */

const encoder = new TextEncoder();

export function sha256Hex(input: string): string {
  const digest = sha256Bytes(encoder.encode(input));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** RFC 4122 v4 id. `crypto.randomUUID` exists in Node 20+ and every modern browser. */
export function uuid(): string {
  return globalThis.crypto.randomUUID();
}
