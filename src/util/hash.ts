import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Hashing helpers shared by the Node tests and the browser demo.
 *
 * `node:crypto` is not available in the browser, and the demo runs this exact
 * code rather than a reimplementation of it, so the hash is provided by a
 * dependency that works in both runtimes. The output is standard SHA-256, so
 * the digests are identical to `createHash('sha256')`.
 */

const encoder = new TextEncoder();

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(encoder.encode(input)));
}

/** RFC 4122 v4 id. `crypto.randomUUID` exists in Node 20+ and every modern browser. */
export function uuid(): string {
  return globalThis.crypto.randomUUID();
}
