import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const VALID = {
  DATABASE_URL: 'postgresql://localhost/db',
  SUPABASE_URL: 'https://real.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
  VAULT_MASTER_KEY: 'a'.repeat(44),
  N8N_BASE_URL: 'https://n8n.internal/',
  N8N_MASTER_WEBHOOK_PATH: '/webhook/master',
  N8N_SIGNING_SECRET: 'signing-secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_live_value',
  VAULT_KEY_VERSIONS: 'v2,v1',
  WEBHOOK_TOLERANCE_SECONDS: '120',
  NODE_ENV: 'development',
} satisfies NodeJS.ProcessEnv;

describe('configuration contract', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(VALID);
    expect(config.vaultKeyVersions).toEqual(['v2', 'v1']);
    expect(config.webhookToleranceSeconds).toBe(120);
    expect(config.n8nBaseUrl).toBe('https://n8n.internal'); // trailing slash stripped
    expect(config.n8nMasterWebhookPath).toBe('webhook/master'); // leading slash stripped
  });

  it('defaults tolerance to five minutes and key versions to v1', () => {
    const { WEBHOOK_TOLERANCE_SECONDS: _t, VAULT_KEY_VERSIONS: _v, ...rest } = VALID;
    const config = loadConfig(rest);
    expect(config.webhookToleranceSeconds).toBe(300);
    expect(config.vaultKeyVersions).toEqual(['v1']);
  });
});

describe('fail-closed validation', () => {
  it('lists every missing variable at once instead of failing one at a time', () => {
    const { DATABASE_URL: _a, VAULT_MASTER_KEY: _b, STRIPE_WEBHOOK_SECRET: _c, ...rest } = VALID;
    let error: ConfigError | undefined;
    try {
      loadConfig(rest);
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.missing.sort()).toEqual([
      'DATABASE_URL',
      'STRIPE_WEBHOOK_SECRET',
      'VAULT_MASTER_KEY',
    ]);
  });

  it('treats an empty string as missing', () => {
    expect(() => loadConfig({ ...VALID, DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/);
  });

  it('rejects placeholder values in production', () => {
    expect(() =>
      loadConfig({ ...VALID, NODE_ENV: 'production', VAULT_MASTER_KEY: 'replace-with-key' }),
    ).toThrow(/VAULT_MASTER_KEY/);
  });

  it('allows placeholder values in development so onboarding is not blocked', () => {
    expect(() =>
      loadConfig({ ...VALID, NODE_ENV: 'development', VAULT_MASTER_KEY: 'replace-with-key' }),
    ).not.toThrow();
  });

  it('rejects an out-of-range tolerance', () => {
    expect(() => loadConfig({ ...VALID, WEBHOOK_TOLERANCE_SECONDS: '0' })).toThrow(/WEBHOOK_TOLERANCE_SECONDS/);
    expect(() => loadConfig({ ...VALID, WEBHOOK_TOLERANCE_SECONDS: '99999' })).toThrow(
      /WEBHOOK_TOLERANCE_SECONDS/,
    );
    expect(() => loadConfig({ ...VALID, WEBHOOK_TOLERANCE_SECONDS: 'abc' })).toThrow(
      /WEBHOOK_TOLERANCE_SECONDS/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
