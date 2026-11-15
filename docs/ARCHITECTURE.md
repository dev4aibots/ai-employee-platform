# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  Edge / API                                                          │
│  inbound webhook  ·  tenant REST  ·  dashboard reads                 │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐   ┌──────────────────────────────────────┐
│  Verification             │   │  Access resolution                   │
│  HMAC-SHA256(t.body)      │   │  pure function, injected clock       │
│  constant-time compare    │   │  trial · past_due+grace · seats ·    │
│  ±300s skew window        │   │  plan features · superadmin          │
└───────────────┬───────────┘   └──────────────────┬───────────────────┘
                │                                  │
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  PostgreSQL  (RLS forced on every tenant table)                      │
│                                                                      │
│   profiles ──< credentials      profiles ──< employees ──< messages  │
│       │                              │                               │
│       ├──< documents (embedding)     └──< workflow_runs              │
│       ├──< audit_log (hash chain)                                    │
│       └──  webhook_receipts (idempotency keys)                       │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐   ┌──────────────────────────────────────┐
│  Hybrid retrieval         │   │  Dispatch                            │
│  lexical (ts_rank, OR)    │   │  sign → POST n8n                     │
│  dense (cosine)           │   │  retry w/ full jitter                │
│  RRF fusion (k=60)        │   │  circuit breaker                     │
└───────────────────────────┘   └──────────────┬───────────────────────┘
                                               ▼
                                ┌──────────────────────────────────────┐
                                │  n8n  →  LiteLLM  →  provider        │
                                └──────────────────────────────────────┘
```

## Request path: one chat turn

1. **Authenticate.** Supabase has already put the JWT subject in `request.jwt.claim.sub`. `auth.uid()` reads it.
2. **Resolve access.** `resolveAccess()` runs before any expensive work. A trial that expired at 09:59 is refused at 10:00 without touching the model, the database or n8n.
3. **Rate limit.** A per-tenant token bucket (`src/ratelimit/bucket.ts`) caps burst. One tenant running a loop cannot consume another tenant's headroom.
4. **Retrieve.** `hybridSearch()` ranks the tenant's own documents. RLS applies, so the query cannot see other tenants even if a service-role caller forgets a filter.
5. **Dispatch.** `dispatchToN8n()` posts a signed, idempotency-keyed payload. Retries are bounded; a dead n8n produces an immediate `circuit_open` instead of a queue of hung requests.
6. **Record.** `workflow_runs` gets model, tokens, cost and latency. `audit_log` gets a hash-chained entry for anything privileged.
7. **Return.** The response carries the decision source (`subscription`, `trial`, `grace`, `superadmin`) so the UI can explain itself.

## Data model

| Table | Owner | RLS | Notes |
|---|---|---|---|
| `profiles` | one row per tenant | select/update own | privileged columns guarded by trigger |
| `credentials` | tenant | all own rows | AES-256-GCM, `unique(user_id, provider)` |
| `employees` | tenant | all own rows | deployed agent instances |
| `messages` | tenant | select/insert own | insert also validates `employee_id` ownership |
| `documents` | tenant | all own rows | `embedding double precision[]`, optional pgvector |
| `workflow_runs` | tenant | select own | written by service role only |
| `audit_log` | tenant or global | select own | append-only; no update/delete policy |
| `webhook_receipts` | platform | no policy | idempotency keys, service-role only |

## Failure paths

**n8n is down.** `dispatchToN8n` retries transient statuses with exponential backoff and full jitter (200 → 400 → 800 → 1600 ms by default, capped at 5 s). After `failureThreshold` consecutive failures the breaker opens, and calls return `{ shortCircuited: true, error: 'circuit_open' }` without a network round trip. After `openMs` the breaker half-opens: one probe is allowed, and success closes it.

**Stripe retries a delivery.** The first insert wins the primary key; every replay returns `duplicate` with the prior state. A concurrent burst of eight identical deliveries produces exactly one `claimed` and seven `duplicate` — asserted in `tests/idempotency.test.ts`.

**A tenant copies a credential row.** GCM authentication fails because the associated data no longer matches. The failure is indistinguishable from a wrong key or a tampered ciphertext, which is intentional: all three mean "do not use this value".

**A secret is missing at boot.** `loadConfig` collects every missing variable and throws once with the full list, rather than failing on the first one after accepting a default. Placeholder values are rejected outright when `NODE_ENV=production`.

**The audit log is edited.** `verifyChain` returns the first index whose hash does not match, and separately whether the chain is internally consistent but shorter than expected (which is why the head hash has to be published somewhere out of band).

## Alternatives rejected

| Option | Why not |
|---|---|
| Application-level `WHERE tenant_id = $1` on every query | One forgotten filter is a silent leak. RLS fails closed and fails visibly. |
| Separate schema or database per tenant | Strong isolation, painful operations: migrations ×N, connection pooling ×N, cross-tenant analytics impossible. RLS gives most of the isolation with one migration path. |
| Row-level `tenant_id` in a JWT claim instead of `auth.uid()` | Two sources of truth for identity. `auth.uid()` is already signed by the auth provider. |
| Column-level `GRANT UPDATE (company_name)` | Workable, but Supabase ships one `authenticated` role, so per-column grants fight the platform. A trigger is explicit and easy to test. |
| Encrypt with a per-tenant data key wrapped by a KMS | The correct end state for a real product with an HSM. Out of scope here; the versioned keyring is the seam where it would slot in. |
| `plainto_tsquery` for the lexical arm | AND semantics collapse recall on multi-term questions. Built from parser lexemes with OR instead. |
| Pure vector search | Drops exact identifiers (SKUs, invoice numbers, error codes) that support teams search for daily. |
| Weighted score fusion instead of RRF | Requires calibrating incomparable score scales per corpus. RRF only uses ranks, so it survives corpus changes. |
| `setTimeout` retries inside the request | Holds a connection open and hides retry state from the caller. Backoff is explicit and the sleep function is injectable. |

## Where this would break at 100× load

Honest list, because "it scales" is not an answer:

1. **In-memory token buckets** are per-process. Ten instances means ten times the intended rate. Fix: Redis with a Lua `INCR`+`EXPIRE`.
2. **The audit chain is written by one process.** Concurrent writers would fork the chain. Fix: a single writer per tenant partition, or a monotonic `seq` allocated in the database with a `UNIQUE` constraint and retry on conflict.
3. **Hybrid search runs two full scans** on `documents`. At 10⁵ rows per tenant this needs the HNSW index from `db/pgvector.sql` plus a GIN index on `to_tsvector(content)`.
4. **`webhook_receipts` grows without bound.** Fix: partition by month and drop partitions older than the provider's replay window (Stripe's is 3 days; 90 days is generous).
5. **The circuit breaker is per-process.** Five instances each probe independently during a half-open window. Fix: shared state in Redis, or accept the extra probes and set `openMs` conservatively.
