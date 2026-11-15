/**
 * Credential vault: AES-256-GCM with a versioned keyring.
 *
 * Threat model this addresses
 * ---------------------------
 * Tenants hand us HubSpot / WhatsApp / Stripe tokens. Those are live
 * credentials to someone else's business, so:
 *
 *  1. Never store plaintext. Encrypt with AES-256-GCM (authenticated).
 *  2. Never use a library default key. A missing key is a startup failure.
 *  3. Support rotation. Ciphertext carries its key version, so a new key can be
 *     introduced without decrypting-and-rewriting the whole table in one
 *     transaction. `needsRotation()` surfaces rows still on an old version.
 *  4. Bind the ciphertext to its context (tenant + provider) via AAD, so a row
 *     copied from tenant A to tenant B fails authentication instead of
 *     decrypting into B's session.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_SALT_PREFIX = 'ai-employee-platform/vault/';

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultOptions {
  /** Base64 or utf8 secret. Must yield at least 32 bytes of key material. */
  masterKey: string;
  /** Ordered newest-first. The first entry is used for new ciphertext. */
  keyVersions?: string[];
}

export interface CipherContext {
  userId: string;
  provider: string;
}

interface ParsedCiphertext {
  version: string;
  iv: Buffer;
  body: Buffer;
  tag: Buffer;
}

function decodeMasterKey(masterKey: string): Buffer {
  if (!masterKey || masterKey.trim() === '') {
    throw new VaultError('VAULT_MASTER_KEY is required; refusing to run with an implicit development key');
  }
  const trimmed = masterKey.trim();
  const base64 = Buffer.from(trimmed, 'base64');
  // Accept a base64 blob of the right size, otherwise treat input as a passphrase.
  if (base64.length >= KEY_BYTES && /^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    return base64;
  }
  if (Buffer.byteLength(trimmed, 'utf8') < 16) {
    throw new VaultError('VAULT_MASTER_KEY must be at least 16 bytes of passphrase or 32 bytes of base64 key material');
  }
  return Buffer.from(trimmed, 'utf8');
}

function deriveKey(master: Buffer, version: string): Buffer {
  return scryptSync(master, `${SCRYPT_SALT_PREFIX}${version}`, KEY_BYTES);
}

function contextAad(ctx: CipherContext): Buffer {
  return Buffer.from(`${ctx.userId}\u0000${ctx.provider}`, 'utf8');
}

export class Vault {
  private readonly keys = new Map<string, Buffer>();
  readonly activeVersion: string;

  constructor(options: VaultOptions) {
    const versions = options.keyVersions?.length ? options.keyVersions : ['v1'];
    const master = decodeMasterKey(options.masterKey);

    for (const version of versions) {
      if (!/^v\d+$/.test(version)) {
        throw new VaultError(`key version "${version}" must look like v1, v2, ...`);
      }
      this.keys.set(version, deriveKey(master, version));
    }

    this.activeVersion = versions[0]!;
  }

  encrypt(plaintext: string, ctx: CipherContext): { ciphertext: string; keyVersion: string } {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new VaultError('refusing to encrypt an empty value');
    }
    const key = this.keys.get(this.activeVersion)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(contextAad(ctx));

    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: [
        this.activeVersion,
        iv.toString('base64'),
        body.toString('base64'),
        tag.toString('base64'),
      ].join(':'),
      keyVersion: this.activeVersion,
    };
  }

  decrypt(ciphertext: string, ctx: CipherContext): string {
    const parsed = this.parse(ciphertext);
    const key = this.keys.get(parsed.version);
    if (!key) {
      throw new VaultError(`unknown key version "${parsed.version}"`);
    }

    const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(contextAad(ctx));
    decipher.setAuthTag(parsed.tag);

    try {
      return Buffer.concat([decipher.update(parsed.body), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong context, or tampering. All three are the same answer.
      throw new VaultError('decryption failed: authentication tag mismatch (wrong key, wrong tenant context, or tampered ciphertext)');
    }
  }

  /** True when this ciphertext was written with an older key version. */
  needsRotation(ciphertext: string): boolean {
    return this.parse(ciphertext).version !== this.activeVersion;
  }

  /** Re-encrypt under the active key version. */
  rotate(ciphertext: string, ctx: CipherContext): { ciphertext: string; keyVersion: string } {
    return this.encrypt(this.decrypt(ciphertext, ctx), ctx);
  }

  /** Constant-time comparison helper used by callers that dedupe secrets. */
  static equal(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  private parse(ciphertext: string): ParsedCiphertext {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) {
      throw new VaultError('malformed ciphertext: expected v<n>:<iv>:<body>:<tag>');
    }
    const [version, ivB64, bodyB64, tagB64] = parts as [string, string, string, string];
    if (!/^v\d+$/.test(version)) {
      throw new VaultError('malformed ciphertext: unknown version prefix');
    }
    return {
      version,
      iv: Buffer.from(ivB64, 'base64'),
      body: Buffer.from(bodyB64, 'base64'),
      tag: Buffer.from(tagB64, 'base64'),
    };
  }
}
