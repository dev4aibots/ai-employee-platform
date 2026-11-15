# ai-employee-platform

A reference implementation of the boring, load-bearing half of a multi-tenant AI employee product: tenancy, credentials, webhooks, dispatch, billing gates and an audit trail. The agent prompts are the easy part. This is the part that decides whether a customer can see another customer's data.

Built as a sanitised, independently testable extraction of a private product I run, so every claim below is backed by a test you can run in six seconds.

| | |
|---|---|
| **Execution mode** | Real code. `npm test` boots PostgreSQL in-process (WASM) and runs the shipped SQL. No mocks, no Docker. |
| **Tests** | 155 passing across 12 files — `npm test` |
| **Type safety** | `strict` TypeScript, `tsc --noEmit` clean |
| **Authorship** | Solo. Original architecture and code. |
| **External dependencies** | One runtime dependency (`@electric-sql/pglite`) |

---

## The problem

An "AI employee" product is a promise that a business can hand an agent its CRM keys, its customer conversations and its documents, and get useful work back. That promise is only credible if the platform can answer five questions with evidence:

1. Can tenant A reach tenant B's rows through any code path?
2. Where do the customer's third-party API keys live, and what happens when one employee copies a ciphertext row into the wrong tenant?
3. Stripe delivers the same webhook three times. Does the customer get charged twice?
4. n8n goes down for ninety seconds. Does the retry storm make it worse?
5. Someone asks "what happened to this account in March?" Is there a log that cannot be quietly edited?

This repository is those five answers, written as code that fails loudly when it is wrong.

---

## What is actually enforced

Each guarantee below names the test that breaks if the guarantee regresses.

| Guarantee | Mechanism | Proof |
|---|---|---|
| Cross-tenant reads return nothing | `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on every tenant table | `tests/rls.test.ts` › *reads* |
| Cross-tenant writes are rejected, not silently dropped | `WITH CHECK (auth.uid() = user_id)` | `tests/rls.test.ts` › *writes* |
| A message cannot reference another tenant's employee | `EXISTS` subquery inside the insert policy | `tests/rls.test.ts` › *cannot attach a message to tenant B employee* |
| A tenant cannot upgrade its own plan, seats, trial or superadmin flag | `BEFORE UPDATE` trigger raising `42501` | `tests/rls.test.ts` › *privilege escalation* (6 cases) |
| An unauthenticated visitor sees nothing | no table grants for `anon`, and no permissive policy | `tests/rls.test.ts` › *anon* |
| Audit rows cannot be edited or deleted by a tenant | no `UPDATE`/`DELETE` policy; append-only by construction | `tests/rls.test.ts` › *audit log immutability* |
| A credential copied into the wrong tenant fails to decrypt | AES-256-GCM with tenant+provider as associated data | `tests/vault.test.ts` › *context binding* |
| Keys rotate without a migration window | versioned keyring, ciphertext carries its version | `tests/vault.test.ts` › *key rotation* |
| A replayed webhook is a no-op | idempotency key as primary key, claim-first insert | `tests/idempotency.test.ts` › *claim protocol* |
| The same key with a different body is rejected | SHA-256 body hash compared on conflict | `tests/idempotency.test.ts` › *key reuse* |
| A stale or tampered inbound signature is rejected | HMAC-SHA256 over `timestamp.body`, constant-time compare, skew window | `tests/hmac.test.ts` |
| n8n retries are bounded and do not stampede | exponential backoff with full jitter; only 408/425/429/5xx retried | `tests/gateway.test.ts` › *dispatch outcomes* |
| A dead upstream becomes a fast failure | circuit breaker: closed → open → half-open | `tests/gateway.test.ts` › *circuit breaker* |
| Audit history is tamper-evident | `entry_hash = sha256(prev_hash ‖ canonical_json(entry))` | `tests/audit.test.ts` › *tamper detection* |
| A missing secret stops the process | `loadConfig` collects every missing variable and throws | `tests/config.test.ts` › *fail-closed validation* |

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
  tenant request    │  access resolution  (pure function)          │
  ─────────────────▶│  trial │ past_due+grace │ seats │ features    │
                    └───────────────┬──────────────────────────────┘
                                    │ allowed
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  PostgreSQL                                                   │
   │  ┌─────────────┬──────────────┬────────────┬───────────────┐  │
   │  │ profiles    │ credentials  │ employees  │ messages      │  │
   │  │ documents   │ workflow_runs│ audit_log  │ receipts      │  │
   │  └─────────────┴──────────────┴────────────┴───────────────┘  │
   │  RLS: auth.uid() = user_id   ·  privileged columns guarded    │
   └───────┬───────────────────────────────┬───────────────────────┘
           │                               │
           ▼                               ▼
  ┌─────────────────┐            ┌──────────────────────────────┐
  │ hybrid retrieval│            │ webhook intake               │
  │ lexical ∪ dense │            │ verify HMAC → claim key →    │
  │ → RRF fusion    │            │ process → mark processed     │
  └─────────────────┘            └──────────────┬───────────────┘
                                                │ signed, idempotent
                                                ▼
                                 ┌──────────────────────────────┐
                                 │ n8n  (orchestration)         │
                                 │ retry + circuit breaker      │
                                 └──────────────────────────────┘
                                                │
                                                ▼
                                 ┌──────────────────────────────┐
                                 │ LiteLLM (model routing)      │
                                 │ cost + latency → workflow_runs│
                                 └──────────────────────────────┘
```

Full detail, including the failure paths and the alternatives I rejected, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quickstart

```bash
git clone https://github.com/dev4aibots/ai-employee-platform.git
cd ai-employee-platform
npm ci

npm test          # 155 tests, ~6s, no Docker
npm run typecheck # strict tsc
npm run demo      # 10 live scenarios printed from real execution
```

`npm run demo` output:

```
1. Tenant isolation — the same query, two sessions, two answers
  Acme   sees: Acme refund policy
  Globex sees: Globex freight SLA
  Acme asking for Globex's document by id  -> 0 rows returned
  Acme asking for Globex's employee by id  -> 0 rows returned
```

The complete transcript is in [`docs/VERIFICATION.md`](docs/VERIFICATION.md), generated by running the command, not written by hand.

### Running against a real database

The portable schema runs unchanged on PostgreSQL 15+ and on Supabase:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/policies.sql
psql "$DATABASE_URL" -f db/pgvector.sql   # optional: native vector column + HNSW
```

`db/roles.sql` is local-only (Supabase already provisions those roles).

---

## Design decisions worth arguing about

**RLS instead of an application-level `WHERE tenant_id = ?`.** A filter in every query works until one query forgets it, and the failure is silent — you get someone else's rows with a 200 OK. RLS puts the check in the database, so the failure mode is an empty result instead of a data leak, and `FORCE ROW LEVEL SECURITY` closes the "table owner ignores policies" hole that makes many RLS setups decorative.

**A trigger for privileged profile columns.** Policies decide *which rows* you can touch, not *which columns*. A tenant legitimately updates `company_name`; it must never update `plan`. Column-level grants are awkward with Supabase's single role, so a `BEFORE UPDATE` trigger compares old against new and raises. The service role opts out by setting `app.privileged`.

**AES-GCM with associated data instead of encrypting the value alone.** Encrypting `secret` alone means a row copied from tenant A to tenant B still decrypts into tenant B's session — the ciphertext has no idea who owns it. Binding `userId`+`provider` as AAD turns a tenancy bug into an authentication failure.

**Portable `double precision[]` instead of hard-requiring pgvector.** The retrieval code is the thing worth testing; requiring a native extension to run the tests means the tests stop running on most laptops and in most CI images. Cosine similarity is 12 lines of SQL, so the same query path executes in both environments, and `db/pgvector.sql` upgrades to `vector(1536)` with an HNSW index when you need scale.

**OR-semantics full-text search built from the parser's own lexemes.** `plainto_tsquery` ANDs every term, so a five-word question matches almost nothing — recall collapse disguised as precision. Building the tsquery with `string_agg(lexeme, ' | ')` over `unnest(to_tsvector(...))` gives OR semantics and, importantly, never interpolates a user string into tsquery syntax, so malformed input cannot raise a syntax error.

**Jitter on every retry.** Synchronised retries from many tenants turn a 30-second n8n blip into a five-minute outage. Full jitter spreads them. It also makes retries non-deterministic, so the clock and the RNG are injected and the tests assert the exact schedule.

---

## What this is not

Being precise about scope is cheaper than being caught out in an interview.

- **It is not a running SaaS.** There is no hosted demo, no Stripe account wired up, no live n8n instance. Those are `docs/ROADMAP.md` items, not claims.
- **The model prices are planning numbers**, not a live provider bill. `src/telemetry/cost.ts` says so at the top and the constants are deliberately conservative so an estimate never under-reports.
- **`llm-benchmarks`-style routing decisions are out of scope here.** The platform *records* cost and latency per run; choosing a model is LiteLLM's job.
- **The seed data is synthetic.** Two fictional tenants, three documents, no real customer.

---

## Layout

```
db/            schema, RLS policies, local roles, seed, pgvector upgrade
src/crypto/    vault (AES-GCM + keyring), HMAC signing and verification
src/tenancy/   access resolution (pure), entitlement checks
src/webhooks/  idempotent claim protocol
src/gateway/   n8n dispatch: retry, backoff, circuit breaker
src/retrieval/ hybrid lexical + dense search with RRF
src/audit/     hash-chained ledger, canonical JSON
src/telemetry/ cost and latency accounting
src/db/        in-process Postgres harness with tenant impersonation
src/cli/       runnable demo
tests/         adversarial suite (155 tests)
```

## License

MIT — see [LICENSE](LICENSE).

## Contact

Devraj Gadhvi · [dev4aibots.com](https://dev4aibots.com) · [hello@dev4aibots.com](mailto:hello@dev4aibots.com) · [linkedin.com/in/devraj0770](https://linkedin.com/in/devraj0770)
