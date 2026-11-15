# Verification receipt

Everything in this file was produced by running the commands on the machine described below. It is a transcript, not a summary. Re-run each command and you should get the same shape of output; only hashes, ciphertext and timings will differ.

## Environment

| | |
|---|---|
| OS | Microsoft Windows 11 Pro (26100) |
| CPU | AMD Ryzen 3 7320U with Radeon Graphics |
| Node | v24.22.1 |
| npm | 11.19.1 |
| TypeScript | 5.9 (`strict`) |
| PostgreSQL | 18.6, compiled to WASM via PGlite 0.5.16 |
| Docker | not used |

```
$ git clone https://github.com/dev4aibots/ai-employee-platform.git
$ cd ai-employee-platform && npm ci
```

---

## 1. Type check

```
$ npm run typecheck
> tsc --noEmit

(no output)
```

Exit code `0`. Zero diagnostics under `strict`, including `noImplicitOverride` and `noFallthroughCasesInSwitch`.

---

## 2. Test suite

```
$ npm test
> vitest run

 RUN  v5.1.0

 ✓ tests/access.test.ts        (17 tests)
 ✓ tests/gateway.test.ts       (13 tests)
 ✓ tests/vault.test.ts         (14 tests)
 ✓ tests/config.test.ts         (8 tests)
 ✓ tests/telemetry.test.ts     (13 tests)
 ✓ tests/audit.test.ts         (15 tests)
 ✓ tests/ops-scoring.test.ts   (21 tests)
 ✓ tests/hmac.test.ts           (9 tests)
 ✓ tests/plans.test.ts         (10 tests)
 ✓ tests/ratelimit.test.ts      (8 tests)
 ✓ tests/ops-pipeline.test.ts  (18 tests)
 ✓ tests/idempotency.test.ts   (10 tests)
 ✓ tests/rls.test.ts           (26 tests)
 ✓ tests/retrieval.test.ts     (12 tests)
 ✓ tests/ops-rls.test.ts        (8 tests)
 ✓ tests/hash.test.ts           (7 tests)

 Test Files  16 passed (16)
      Tests  209 passed (209)
   Duration  10.45s
```

No Docker, no network, no environment variables required. Six files boot a real PostgreSQL instance and execute the SQL in `db/`. `vitest.config.ts` caps the pool at four workers because six concurrent WASM databases exceed a modest laptop's memory and make startup time out — which looks like a failing test but is not one.

---

## 3. Operations report

The command runs the play against the 140-lead fixture, makes a day of decisions, sends the approved drafts through the dry-run provider, and prints counts read back from the database.

```
$ npm run report
> tsx src/cli/report.ts

ai-employee-platform :: operations report
fixture   db/ops_seed.sql (140 leads, 2 tenants, deterministic)
clock     2026-11-15T12:16:39.235Z

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
  score bands         5 hot   75 warm   28 cool   32 cold   avg 50.5

SOURCES
  event      leads   28   replies    4   reply rate 14.3%
  inbound    leads   28   replies    4   reply rate 14.3%
  outbound   leads   28   replies    4   reply rate 14.3%
  partner    leads   28   replies    4   reply rate 14.3%
  referral   leads   28   replies    4   reply rate 14.3%

RUN LEDGER
  9fadf1b1  awaiting_approval leads   96  drafts   8  $0.000000

NOTE  Fixture numbers from db/ops_seed.sql, not customer data.
      Reproduce with: npm run report   (2224 ms)
```

The `cost` and `tokens` fields are `0` because `templateWriter` makes no model call and reports that honestly. Run the same numbers twice and the second run reports `drafts created 0` — the content hashes already exist.

---

## 4. Tenancy demo

```
$ npm run demo
```

```
────────────────────────────────────────────────────────────────────────
1. Tenant isolation — the same query, two sessions, two answers
────────────────────────────────────────────────────────────────────────
  Acme   sees: Acme refund policy
  Globex sees: Globex freight SLA
  Acme asking for Globex's document by id  -> 0 rows returned
  Acme asking for Globex's employee by id  -> 0 rows returned

────────────────────────────────────────────────────────────────────────
2. Privilege escalation — a tenant trying to give itself a better deal
────────────────────────────────────────────────────────────────────────
  ✓ set plan to 'scale': blocked — privilege_escalation
  ✓ grant 500 seats: blocked — privilege_escalation
  ✓ become superadmin: blocked — privilege_escalation

────────────────────────────────────────────────────────────────────────
3. Access decisions — pure function, injected clock
────────────────────────────────────────────────────────────────────────
  active    -> ALLOW [ok]  Subscription active.
  trialing  -> ALLOW [trial_active]  Trial is active.
  trialing  -> DENY  [trial_expired]  Trial ended. Choose a plan to keep your AI employees running.
  past_due  -> ALLOW [past_due_grace]  Access continues during the payment grace period.
  past_due  -> DENY  [past_due]  Payment failed. Update the payment method to restore access.
  canceled  -> DENY  [canceled]  Subscription canceled. Reactivate to continue.

────────────────────────────────────────────────────────────────────────
4. Credential vault — encryption, tenant binding, rotation
────────────────────────────────────────────────────────────────────────
  plaintext : demo-hubspot-token-not-a-real-value
  at rest   : v1:PM0xug2drgmXCD+A:22xnHriNlPJt/fTIRlcNSM/OKwGkujoN…
  decrypt   : demo-hubspot-token-not-a-real-value
  ✓ tenant B cannot decrypt tenant A secret (bound to tenant + provider)
  rotation  : v1 -> v2, value preserved = true

────────────────────────────────────────────────────────────────────────
5. Webhook idempotency — Stripe retries the same event three times
────────────────────────────────────────────────────────────────────────
  delivery 1        -> claimed
  delivery 2        -> duplicate (no second email, no second charge)
  same key, new body-> conflict (idempotency key reused with a different payload)

────────────────────────────────────────────────────────────────────────
6. Inbound signature verification — replay and tamper
────────────────────────────────────────────────────────────────────────
  valid signature   -> ok=true
  replayed 1h later -> ok=false reason=stale_timestamp
  body tampered     -> ok=false reason=signature_mismatch

────────────────────────────────────────────────────────────────────────
7. Hybrid retrieval — exact identifiers next to paraphrase
────────────────────────────────────────────────────────────────────────
  0.03279  lexical= 1  vector= 1  Acme refund policy
  0.03200  lexical= 2  vector= 3  Bearing kit lookup
  0.01613  lexical= -  vector= 2  Hardware warranty
  (a document ranked by only one arm scores lower — that is RRF doing its job)

────────────────────────────────────────────────────────────────────────
8. Audit ledger — hash chain and tamper detection
────────────────────────────────────────────────────────────────────────
  entries           : 3
  head hash         : 2af2a6cd36de244db3d53def…
  chain valid       : true
  after edit entry 1: valid=false brokenAt=1 (entry 1 hash does not match its contents)

────────────────────────────────────────────────────────────────────────
9. Retry policy — bounded, jittered, deterministic to test
────────────────────────────────────────────────────────────────────────
  backoff schedule (no jitter): 200ms, 400ms, 800ms, 1600ms, 3200ms

────────────────────────────────────────────────────────────────────────
10. Cost and latency telemetry
────────────────────────────────────────────────────────────────────────
  runs            : 4
  total cost      : $0.035445
  latency p50/p95 : 420ms / 2400ms
  cost by model   : gpt-4o-mini=$0.000495, claude-sonnet-4.6=$0.034950

════════════════════════════════════════════════════════════════════════
All sections executed against a live in-process PostgreSQL.
════════════════════════════════════════════════════════════════════════
```

Section 4 prints a ciphertext prefix that changes on every run because the IV is random — that is the point. The plaintext in the demo is a fake token, present so the round trip is visibly real.

---

## 5. Browser console

Verified in Chrome on this machine against the production build (`vite build` + `vite preview`):

| Check | Result |
|---|---|
| Boot (schema, roles, policies, ops schema, seed, first run) | completes in ~2s; no console errors |
| Overview | 140 leads, 8 awaiting approval, funnel and source counts match `npm run report` |
| Leads | 140 rows; drawer shows the contributions and the signal behind each score |
| Approvals | approve → queue drops 8→7, decided row shows `approved`, audit chip becomes `1 verified` |
| Send | dry-run receipt returned; draft becomes `sent`; lead stage becomes `contacted` |
| Isolation | `leads 140 / 0`, `drafts 8 / 0`; both attack buttons return the PostgreSQL error |
| Run play (second time) | `96 leads examined, 0 new drafts: every content hash already exists` |

The earlier version of this demo had a real bug: two concurrent `asTenant` calls on one PGlite session reset each other's role, so the isolation table showed `0 / 0` for every table. The console now serialises identity switches behind a queue, and `tests/ops-pipeline.test.ts` covers the single-session rule in Node.

---

## 6. What is deliberately not verified here

Listed so nobody has to discover it:

| Claim | Status |
|---|---|
| A real email provider sends the draft | Not implemented. `EmailProvider` is the seam; the shipped provider is `dry-run` and returns a deterministic receipt. |
| An LLM writes the draft | Not enabled. `DraftWriter` is the interface; `templateWriter` is the implementation and reports zero tokens. |
| Runs on a live Supabase project | Not tested in this repo. The SQL is Supabase-shaped (`auth.uid()`, `authenticated`/`anon`/`service_role`) but a live-project run is a roadmap item. |
| Real Stripe/PayPal webhook delivery | Signature verification and idempotency are tested; the HTTP endpoints that call them are not part of this repo. |
| Live n8n instance | Dispatch is tested against a stubbed `fetch` that returns real HTTP status codes. No n8n container is started. |
| Vector index performance at scale | The portable schema uses `double precision[]`; `db/pgvector.sql` adds the native column and HNSW index, but no large-corpus benchmark has been run. |
| Production load / concurrency | Not benchmarked. The approval and send races are tested inside one process; cross-process concurrency relies on the database constraints, not on a load test. |

---

## Reproduce

```bash
npm ci
npm run typecheck
npm test
npm run report
npm run demo
```

If any command above fails on a clean clone, that is a bug and the receipt above is wrong. Open an issue.
