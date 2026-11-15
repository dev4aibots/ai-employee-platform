# ai-employee-platform

An AI employee you can put in front of a customer's pipeline: it finds the leads that went quiet, scores them from evidence a salesperson can inspect, drafts the follow-up, and then stops. A named human approves. The decision is written into a hash chain. Only then can anything send.

The prompt is the easy part. This repository is the part that decides whether tenant A can read tenant B's rows, whether a retry emails the same person twice, and whether "what happened to this account in March?" has an answer that cannot be quietly edited.

Built as a sanitised, independently testable extraction of a private multi-tenant product I run.

| | |
|---|---|
| **Live console** | [ai-employee-platform-dev4aibots.vercel.app](https://ai-employee-platform-dev4aibots.vercel.app) — boots PostgreSQL in the browser and runs this pipeline for real. Also on [GitHub Pages](https://dev4aibots.github.io/ai-employee-platform/). |
| **Execution mode** | Real code. `npm test` boots PostgreSQL in-process (WASM) and runs the shipped SQL and the shipped TypeScript. No mocks, no Docker. |
| **Tests** | 202 passing across 15 files — `npm test` |
| **Type safety** | `strict` TypeScript, `tsc --noEmit` clean |
| **CI** | typecheck + tests on Node 20/22/24, operation report, gitleaks, env-contract check, demo build, generated-SQL drift check |
| **Runtime dependencies** | `@electric-sql/pglite`, `@noble/hashes` |
| **Authorship** | Solo. Original architecture and code. |

---

## The loop

```
goal: "find the leads that have not replied in 7 days,
       rank them, draft the outreach"
                    │
                    ▼
        ┌───────────────────────┐
        │ 1. select             │  SQL: stage in (new, qualified, contacted)
        │    stale, unanswered  │       replied_at is null
        └──────────┬────────────┘       last_contact_at <= now - 7d
                   ▼
        ┌───────────────────────┐
        │ 2. score with         │  40 baseline + stage + contact recency
        │    attribution        │  + company fit + weighted signals
        └──────────┬────────────┘  every point names its reason
                   ▼
        ┌───────────────────────┐
        │ 3. draft              │  content hash is the idempotency key;
        │    (deterministic)     │  a replay writes nothing
        └──────────┬────────────┘
                   ▼
        ┌───────────────────────┐
        │ 4. STOP               │  drafts land in the approval queue.
        │    awaiting_approval   │  Nothing leaves the system here.
        └──────────┬────────────┘
                   ▼
        ┌───────────────────────┐
        │ 5. human decision     │  approved | rejected, exactly once,
        │    hash-chained       │  ordered by a per-tenant sequence
        └──────────┬────────────┘
                   ▼
        ┌───────────────────────┐
        │ 6. send               │  write-ahead claim on a unique draft_id:
        │    once               │  two callers cannot both reach the provider
        └───────────────────────┘
```

Every step writes to `ops_run_steps` with its latency and attempt count, so the console can show what happened without parsing logs.

---

## What the console shows

The demo is the product, not a landing page. It boots PostgreSQL (PGlite — the real engine compiled to WebAssembly) in the tab, applies the repository's own SQL, and calls the same `src/ops` code the Node tests call.

| View | What it answers |
|---|---|
| **Overview** | Pipeline stage counts, reply rate per source, the last run's step timeline, recent runs. |
| **Leads** | 140 scored leads. Click one to see every point of its score attributed to a named contribution and the raw signal behind it. |
| **Approvals** | The draft queue with the full email, the evidence that justified it, and approve/reject. Decisions move into a hash-chained audit entry. |
| **Run ledger** | One row per invocation, one row per step, with attempts and latency. Failed runs stay failed. |
| **Isolation** | The same table counted as two tenants, plus two live attacks: Globex inserting a row owned by Acme, and `anon` reading `leads`. The error text is what PostgreSQL returned. |

---

## What is actually enforced

Each guarantee names the test that turns red if it regresses.

### Tenancy, secrets, webhooks, audit

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

### The operations pipeline

| Guarantee | Mechanism | Proof |
|---|---|---|
| Running the same play twice cannot duplicate outreach | `unique (user_id, content_hash)` + `on conflict do nothing` | `tests/ops-pipeline.test.ts` › *is idempotent* |
| A draft is decided exactly once and cannot be flipped | `approvals.draft_id` is unique; a replay returns the stored row | › *cannot flip a rejection into an approval* |
| Approvals are ordered even in the same millisecond | per-tenant `seq`, unique, ordered chain | › *verifyApprovalChain* |
| A tampered decision breaks verification | `sha256(prev_hash ‖ seq ‖ content_hash ‖ decision ‖ actor ‖ decided_at ‖ note)` | › *detects a tampered decision* |
| Two callers cannot both send the same draft | write-ahead `sending` claim on unique `draft_id` | › *claims the send before calling the provider* |
| A failed send is recorded and can be retried | `sends.status` machine: `sending → failed → sending → sent` | › *records a failed send and allows a retry* |
| A crashed run is not left "running" | `catch` persists the steps, then marks the run `failed` | › *records a failed run instead of leaving it running* |
| Cost cannot be invented | the offline writer reports 0 tokens and $0, because it makes no model call | › *reports zero cost honestly* |
| The dashboard view cannot leak across tenants | `security_invoker = true` on the view, RLS on all seven ops tables | `tests/ops-rls.test.ts` › *the pipeline view obeys the caller* |
| The score is auditable | every point is a named `Contribution` with a reason, and the points sum to the score | `tests/ops-scoring.test.ts` › *attributes every point* |

---

## Measured output

`npm run report` runs the play against the fixture, makes a day of decisions, sends the approved drafts through the dry-run provider, and prints what the database holds. Real output:

```
PLAY  Find leads that have not replied in 7 days, rank them, draft the outreach
  leads examined         96
  drafts created          8
  drafts skipped          0   (content hash already present)
  tokens / cost           0 / $0.000000   (offline writer, no model call)
  step latency        p50 2 ms   p95 14 ms

DECISIONS
  approved                6
  rejected                2
  chain               verified (8 entries)

SENDS
  sent                    6   (provider: dry-run)
  failed                  0
  provider receipts       6 unique

PIPELINE
  leads                 140   qualified 46   contacted 37   replied 8
  queue                   0 pending   decisions per draft 100.0%
  runs                    1   success 100.0%   failed 0
```

These are fixture numbers from `db/ops_seed.sql`, not customer data. The fixture is 140 leads generated from modulo arithmetic, so every run sees the same pipeline.

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
   │  tenancy      profiles · credentials · employees · documents  │
   │  operations   leads · lead_signals · drafts · approvals ·     │
   │               sends · ops_runs · ops_run_steps                │
   │  RLS: auth.uid() = user_id   ·  privileged columns guarded     │
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
                                 └──────────────┬───────────────┘
                                                │
                                                ▼
                                 ┌──────────────────────────────┐
                                 │ LiteLLM (model routing)      │
                                 │ cost + latency → workflow_runs│
                                 └──────────────────────────────┘

  operations loop
  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
  │ select     │──▶│ score      │──▶│ draft      │──▶│ approve    │
  │ stale leads│   │ attributed │   │ content-   │   │ hash chain │
  └────────────┘   └────────────┘   │ hashed     │   └─────┬──────┘
                                    └────────────┘         │
                                                           ▼
                                                    ┌────────────┐
                                                    │ send once  │
                                                    └────────────┘
```

Full detail, including the failure paths and the alternatives I rejected, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quickstart

**See it running first:** [ai-employee-platform-dev4aibots.vercel.app](https://ai-employee-platform-dev4aibots.vercel.app) boots the database in your tab and runs the pipeline. No server, no keys.

```bash
git clone https://github.com/dev4aibots/ai-employee-platform.git
cd ai-employee-platform
npm ci

npm test          # 202 tests, ~8s, no Docker
npm run typecheck # strict tsc
npm run report    # the operations report above
npm run demo      # the tenancy scenarios from the original build
```

### Running against a real database

The portable schema runs unchanged on PostgreSQL 15+ and on Supabase:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/roles.sql      # local only; Supabase provisions these
psql "$DATABASE_URL" -f db/policies.sql
psql "$DATABASE_URL" -f db/ops.sql
psql "$DATABASE_URL" -f db/seed.sql
psql "$DATABASE_URL" -f db/ops_seed.sql
psql "$DATABASE_URL" -f db/pgvector.sql   # optional: native vector column + HNSW
```

---

## Design decisions worth arguing about

**RLS instead of an application-level `WHERE tenant_id = ?`.** A filter in every query works until one query forgets it, and the failure is silent — you get someone else's rows with a 200 OK. RLS puts the check in the database, so the failure mode is an empty result instead of a data leak, and `FORCE ROW LEVEL SECURITY` closes the "table owner ignores policies" hole that makes many RLS setups decorative.

**The content hash is the idempotency key, not the lead id.** "Draft this lead twice" is only a problem if the second draft is different; if the template is deterministic, the second write collides on `(user_id, content_hash)` and does nothing. That makes re-running a play safe by construction, and it makes a non-deterministic writer a correctness bug rather than a style choice.

**A write-ahead claim before the provider call.** Checking "has this been sent?" and then sending is a race. The `sends` row is inserted with status `sending` before the provider is called, and `draft_id` is unique, so the loser of a race sees `sending` and refuses. A crash mid-send leaves a visible `sending` row for an operator instead of a silent double-send.

**A per-tenant sequence instead of timestamp ordering.** Two approvals in the same millisecond verify in a different order than they were written if the chain is ordered by `decided_at`, and the hash chain then reports tampering that never happened. `seq` is unique per tenant and the chain is ordered by it.

**Attribution-first scoring.** A score a salesperson cannot interrogate is a score they will ignore. `scoreLead` returns the number *and* the contributions that produced it, each with a human-readable reason, and the tests assert that the contributions sum to the score. The weights live on the signal rows, so the model can be re-tuned per tenant without a deploy.

**The offline writer reports zero cost.** A template writer that invents plausible token counts makes every downstream cost number fiction. It reports `0` tokens and `$0.00`, and the console shows `$0.00` next to `writer: template-v1` so nobody mistakes it for a measured model bill.

**One connection, one identity.** PGlite is a single session, so tenant impersonation is session state. The browser console serialises every identity switch behind a queue; without it, two concurrent reads interleave, the second resets the first's role, and both queries return zero rows. That bug was found in this repository's own demo and is the reason `asTenant` is not allowed to run concurrently.

**Jitter on every retry.** Synchronised retries from many tenants turn a 30-second n8n blip into a five-minute outage. Full jitter spreads them. It also makes retries non-deterministic, so the clock and the RNG are injected and the tests assert the exact schedule.

---

## What this is not

Being precise about scope is cheaper than being caught out in an interview.

- **It is not wired to a real CRM or mailbox.** The email provider is `dry-run`: it returns a deterministic receipt and sends nothing. `EmailProvider` is the seam a real provider plugs into.
- **Drafting is a deterministic template, not an LLM call.** `DraftWriter` is the interface; `templateWriter` is the implementation that ships, and it reports zero tokens because it makes no model call. The point of the repository is the loop around the writer, not the prose.
- **It is not a Stripe-wired SaaS.** There is no billing account, no live n8n instance and no hosted multi-tenant deployment. Those are `docs/ROADMAP.md` items, not claims.
- **The model prices are planning numbers**, not a live provider bill. `src/telemetry/cost.ts` says so at the top and the constants are deliberately conservative so an estimate never under-reports.
- **The data is synthetic.** Two fictional tenants, 140 generated leads, no real customer.

---

## Layout

```
db/            schema, RLS policies, roles, seed, operations schema + fixture
src/ops/       scoring, drafting, pipeline, approvals, sends, read models
src/crypto/    vault (AES-GCM + keyring), HMAC signing and verification
src/tenancy/   access resolution (pure), entitlement checks
src/webhooks/  idempotent claim protocol
src/gateway/   n8n dispatch: retry, backoff, circuit breaker
src/retrieval/ hybrid lexical + dense search with RRF
src/audit/     hash-chained ledger, canonical JSON
src/telemetry/ cost and latency accounting
src/util/      isomorphic SHA-256 + UUID (browser and Node)
src/db/        in-process Postgres harness with tenant impersonation
src/cli/       demo and operations report
demo/          the browser console (Vite + PGlite, no server)
tests/         adversarial suite (202 tests)
```

## License

MIT — see [LICENSE](LICENSE).

## Contact

Devraj Gadhvi · [dev4aibots.com](https://dev4aibots.com) · [hello@dev4aibots.com](mailto:hello@dev4aibots.com) · [linkedin.com/in/devraj0770](https://linkedin.com/in/devraj0770)
