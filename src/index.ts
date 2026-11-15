/**
 * Public surface of the platform core.
 *
 * Consumers (an HTTP layer, a worker, a CLI) import from here rather than from
 * individual files, so internal moves do not ripple outward.
 */

export { ConfigError, loadConfig, type Config } from './config.js';

export { Vault, VaultError, type CipherContext, type VaultOptions } from './crypto/vault.js';
export { signPayload, verifySignature, type VerifyOptions, type VerifyResult } from './crypto/hmac.js';

export { resolveAccess, type AccessCode, type AccessDecision, type TenantProfile } from './tenancy/access.js';

export {
  PLANS,
  PRICE_TABLE,
  OVERAGE_USD_PER_RUN,
  billUsage,
  isPlanId,
  planAllows,
  planForPrice,
  seatLimit,
  type Feature,
  type Plan,
  type PlanId,
  type UsageBill,
} from './billing/plans.js';

export {
  IdempotencyService,
  idempotencyKeyFor,
  payloadHash,
  type ClaimInput,
  type ClaimOutcome,
} from './webhooks/idempotency.js';

export {
  CircuitBreaker,
  DEFAULT_RETRY,
  backoffDelay,
  dispatchToN8n,
  isTransientStatus,
  type CircuitState,
  type DispatchDeps,
  type DispatchRequest,
  type DispatchResult,
  type RetryPolicy,
} from './gateway/n8n.js';

export { hybridSearch, cosineSimilarity, type HybridSearchOptions, type RetrievedDocument } from './retrieval/hybrid.js';

export { AuditLedger, GENESIS_HASH, canonicalJson, type AuditEntry, type AuditInput } from './audit/ledger.js';

export { TokenBucket, TenantRateLimiter, type BucketOptions, type ConsumeResult } from './ratelimit/bucket.js';

export {
  MODEL_PRICES,
  computeCostUsd,
  percentile,
  summarizeRuns,
  type ModelPrice,
  type RunSample,
  type TelemetrySummary,
} from './telemetry/cost.js';
