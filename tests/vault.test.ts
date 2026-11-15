import { describe, expect, it } from 'vitest';
import { Vault, VaultError } from '../src/crypto/vault.js';

const MASTER = 'vault-test-master-key-with-enough-entropy';
const CTX = { userId: '11111111-1111-4111-8111-111111111111', provider: 'hubspot' };

describe('vault lifecycle', () => {
  it('round-trips a secret', () => {
    const vault = new Vault({ masterKey: MASTER });
    const { ciphertext, keyVersion } = vault.encrypt('hs_pat_live_abc123', CTX);

    expect(keyVersion).toBe('v1');
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(ciphertext.split(':')).toHaveLength(4);
    expect(ciphertext).not.toContain('hs_pat_live_abc123');
    expect(vault.decrypt(ciphertext, CTX)).toBe('hs_pat_live_abc123');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const vault = new Vault({ masterKey: MASTER });
    const a = vault.encrypt('same-secret', CTX).ciphertext;
    const b = vault.encrypt('same-secret', CTX).ciphertext;
    expect(a).not.toBe(b);
    expect(vault.decrypt(a, CTX)).toBe(vault.decrypt(b, CTX));
  });

  it('refuses an empty plaintext', () => {
    const vault = new Vault({ masterKey: MASTER });
    expect(() => vault.encrypt('', CTX)).toThrow(VaultError);
  });
});

describe('vault fail-closed behaviour', () => {
  it('throws when the master key is missing instead of inventing a default', () => {
    expect(() => new Vault({ masterKey: '' })).toThrow(/VAULT_MASTER_KEY is required/);
  });

  it('throws when the master key is too short to be meaningful', () => {
    expect(() => new Vault({ masterKey: 'short' })).toThrow(/at least 16 bytes/);
  });

  it('rejects malformed key version labels', () => {
    expect(() => new Vault({ masterKey: MASTER, keyVersions: ['prod-2026'] })).toThrow(/must look like v1/);
  });

  it('rejects malformed ciphertext', () => {
    const vault = new Vault({ masterKey: MASTER });
    expect(() => vault.decrypt('not-a-ciphertext', CTX)).toThrow(/malformed ciphertext/);
    expect(() => vault.decrypt('v1:aaaa:bbbb', CTX)).toThrow(/malformed ciphertext/);
  });

  it('rejects an unknown key version', () => {
    const writer = new Vault({ masterKey: MASTER, keyVersions: ['v9'] });
    const ciphertext = writer.encrypt('secret', CTX).ciphertext;
    const reader = new Vault({ masterKey: MASTER, keyVersions: ['v1'] });
    expect(() => reader.decrypt(ciphertext, CTX)).toThrow(/unknown key version "v9"/);
  });
});

describe('vault context binding', () => {
  it('fails when another tenant tries to decrypt the row', () => {
    const vault = new Vault({ masterKey: MASTER });
    const ciphertext = vault.encrypt('tenant-a-secret', CTX).ciphertext;
    expect(() =>
      vault.decrypt(ciphertext, { ...CTX, userId: '22222222-2222-4222-8222-222222222222' }),
    ).toThrow(/authentication tag mismatch/);
  });

  it('fails when the provider is swapped', () => {
    const vault = new Vault({ masterKey: MASTER });
    const ciphertext = vault.encrypt('tenant-a-secret', CTX).ciphertext;
    expect(() => vault.decrypt(ciphertext, { ...CTX, provider: 'whatsapp' })).toThrow(
      /authentication tag mismatch/,
    );
  });

  it('detects a tampered body', () => {
    const vault = new Vault({ masterKey: MASTER });
    const [version, iv, body, tag] = vault.encrypt('original', CTX).ciphertext.split(':');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [version, iv, flipped.toString('base64'), tag].join(':');
    expect(() => vault.decrypt(tampered, CTX)).toThrow(/authentication tag mismatch/);
  });
});

describe('vault key rotation', () => {
  it('decrypts old ciphertext after a new key version is introduced', () => {
    const v1Only = new Vault({ masterKey: MASTER, keyVersions: ['v1'] });
    const old = v1Only.encrypt('legacy-secret', CTX).ciphertext;

    const rotated = new Vault({ masterKey: MASTER, keyVersions: ['v2', 'v1'] });
    expect(rotated.activeVersion).toBe('v2');
    expect(rotated.decrypt(old, CTX)).toBe('legacy-secret');
    expect(rotated.needsRotation(old)).toBe(true);
  });

  it('re-encrypts under the active version and stops needing rotation', () => {
    const v1Only = new Vault({ masterKey: MASTER, keyVersions: ['v1'] });
    const old = v1Only.encrypt('legacy-secret', CTX).ciphertext;

    const rotated = new Vault({ masterKey: MASTER, keyVersions: ['v2', 'v1'] });
    const fresh = rotated.rotate(old, CTX);

    expect(fresh.keyVersion).toBe('v2');
    expect(rotated.needsRotation(fresh.ciphertext)).toBe(false);
    expect(rotated.decrypt(fresh.ciphertext, CTX)).toBe('legacy-secret');
  });

  it('cannot read v2 ciphertext once the v2 key is dropped from the ring', () => {
    const both = new Vault({ masterKey: MASTER, keyVersions: ['v2', 'v1'] });
    const ciphertext = both.encrypt('secret', CTX).ciphertext;
    const v1Only = new Vault({ masterKey: MASTER, keyVersions: ['v1'] });
    expect(() => v1Only.decrypt(ciphertext, CTX)).toThrow(/unknown key version/);
  });
});
