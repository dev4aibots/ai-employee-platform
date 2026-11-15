/**
 * Fail-closed configuration loading.
 *
 * The original prototype this platform is derived from read
 * `process.env.X || 'some-default'` in a dozen places. That pattern turns a
 * missing payment secret into a silently insecure deployment, so here every
 * required variable is validated once at boot and the process refuses to start
 * with a precise list of what is missing.
 */

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    super(
      [
        missing.length ? `missing required environment variables: ${missing.join(', ')}` : '',
        invalid.length ? `invalid environment variables: ${invalid.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

export interface Config {
  databaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  vaultMasterKey: string;
  vaultKeyVersions: string[];
  n8nBaseUrl: string;
  n8nMasterWebhookPath: string;
  n8nSigningSecret: string;
  stripeWebhookSecret: string;
  paypalWebhookId: string;
  webhookToleranceSeconds: number;
  nodeEnv: 'development' | 'production' | 'test';
}

const REQUIRED = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VAULT_MASTER_KEY',
  'N8N_BASE_URL',
  'N8N_MASTER_WEBHOOK_PATH',
  'N8N_SIGNING_SECRET',
  'STRIPE_WEBHOOK_SECRET',
] as const;

/** A value that is present but obviously still a placeholder. */
function looksLikePlaceholder(value: string): boolean {
  return /replace|changeme|your-key|xxx|placeholder/i.test(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const name of REQUIRED) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      missing.push(name);
    } else if (looksLikePlaceholder(raw) && env.NODE_ENV === 'production') {
      invalid.push(name);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new ConfigError(missing, invalid);
  }

  const toleranceRaw = env.WEBHOOK_TOLERANCE_SECONDS ?? '300';
  const tolerance = Number(toleranceRaw);
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 3600) {
    invalid.push('WEBHOOK_TOLERANCE_SECONDS');
  }

  const versions = (env.VAULT_KEY_VERSIONS ?? 'v1')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (versions.length === 0) {
    invalid.push('VAULT_KEY_VERSIONS');
  }

  if (invalid.length > 0) {
    throw new ConfigError([], invalid);
  }

  const nodeEnv = (env.NODE_ENV ?? 'development') as Config['nodeEnv'];
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new ConfigError([], ['NODE_ENV']);
  }

  return {
    databaseUrl: env.DATABASE_URL!,
    supabaseUrl: env.SUPABASE_URL!,
    supabaseAnonKey: env.SUPABASE_ANON_KEY!,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    vaultMasterKey: env.VAULT_MASTER_KEY!,
    vaultKeyVersions: versions,
    n8nBaseUrl: env.N8N_BASE_URL!.replace(/\/+$/, ''),
    n8nMasterWebhookPath: env.N8N_MASTER_WEBHOOK_PATH!.replace(/^\/+/, ''),
    n8nSigningSecret: env.N8N_SIGNING_SECRET!,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET!,
    paypalWebhookId: env.PAYPAL_WEBHOOK_ID ?? '',
    webhookToleranceSeconds: tolerance,
    nodeEnv,
  };
}
