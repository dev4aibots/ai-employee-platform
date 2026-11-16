# AI Business Operations Agent

A multi-tenant AI sales-operations agent that finds leads that went quiet, scores them with per-signal attribution, drafts the follow-up — then **stops** for a named human approval. Approvals enter a SHA-256 hash chain. Only then can anything send. Cross-tenant reads are blocked in PostgreSQL with `FORCE ROW LEVEL SECURITY`. Retries are safe by construction: content-hash idempotency on drafts, a write-ahead `sending` claim on a unique draft id, and a per-tenant sequence so same-millisecond decisions never falsely report a tampered chain.

Built as a sanitised, independently testable extraction of a private multi-tenant product.

<p align="center">
  <a href="https://ai-employee-platform-dev4aibots.vercel.app"><img src="https://img.shields.io/badge/demo-live%20console-4e8cff?style=for-the-badge&logo=vercel" alt="Live console"></a>
  <a href="https://dev4aibots.github.io/ai-employee-platform/"><img src="https://img.shields.io/badge/pages-github-4e8cff?style=for-the-badge&logo=github" alt="GitHub Pages"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-209%20passing-2fd08a?style=for-the-badge" alt="209 tests passing">
  <img src="https://img.shields.io/badge/files-16-4e8cff?style=for-the-badge" alt="16 test files">
  <img src="https://img.shields.io/badge/ci-node%2020%2F22%2F24-58b7ff?style=for-the-badge&logo=githubactions" alt="CI on Node 20/22/24">
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?style=for-the-badge&logo=typescript" alt="Strict TypeScript">
  <img src="https://img.shields.io/badge/deps-2--zero%20runtime%20engine-2fd08a?style=for-the-badge" alt="Two runtime deps, no engine">
  <img src="https://img.shields.io/badge/rls-postgres--row--level--security-ff6b7a?style=for-the-badge&logo=postgresql" alt="Postgres RLS">
</p>

---

## What it does

```
┌─────────────────────────────────────────────────────────────────┐
│  GOAL: "Find leads quiet 7+ days, rank them, draft outreach"   │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
   ┌──────────────┐                        ┌──────────────┐
   │ 1. SELECT    │                        │ 2. SCORE     │
   │ stale leads  │                        │ attribution  │
   │ SQL: replied │   40 baseline + stage  │   every      │   point names
   │ _at IS NULL  │   + recency + fit +    │   its reason │
   │   AND last_  │   weighted signals     │              │
   │   _contact_  │                        │              │
   │   <= now-7d  │                        └──────────────┘
   └──────────────┘                           │
                              │               ▼
                              │         ┌──────────────┐
                              │         │ 3. DRAFT     │
                              │         │ deterministic│
                              │         │ content hash │
                              │         │ = idempotency│
                              │         │   key        │
                              └─────────►──────────────┘
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │ 4. STOP      │
                                     │ awaiting_    │
                                     │ approval     │
                                     │ Nothing      │
                                     │ leaves here  │
                                     └──────────────┘
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │ 5. HUMAN     │
                                     │ DECISION     │
                                     │ approved/rej.│
                                     │ hash-chained │
                                     │ per-tenant   │
                                     │   sequence   │
                                     └──────────────┘
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │ 6. SEND      │
                                     │ once         │
                                     │ write-ahead  │
                                     │ claim on     │
                                     │  draft_id    │
                                     └──────────────┘
```

Every step writes to `ops_run_steps` with latency and attempt count, so the console shows what happened without parsing logs.

---

## What the console shows

The demo **is** the product — it boots PostgreSQL (PGlite, the real engine compiled to WebAssembly) in the tab, applies the repository's own SQL, and calls the same `src/ops` code the Node tests call. Every number on screen is computed from the live database.

| View | What it answers |
|------|-----------------|
| **Overview** | Pipeline stage counts, reply rate per source, last run's step timeline, recent runs |
| **Leads** | 140 scored leads. Click one to see every score point attributed to a named signal |
| **Approvals** | Draft queue with full email, evidence, approve/reject. Decisions enter the hash chain |
| **Run ledger** | One row per invocation, one per step, with attempts and latency. Failed runs stay failed |
| **Isolation** | Same table as two tenants, plus two live attacks: cross-tenant row insert and `anon` reading `leads`. The error text is PostgreSQL's own |

---

## What is actually enforced

Each guarantee names the test that turns red if it regresses.

| Guarantee | Mechanism | Test |
|-----------|-----------|------|
| Tenant isolation | `FORCE ROW LEVEL SECURITY` on `leads` | 34 adversarial cross-tenant reads return 0 rows |
| No double-send | Write-ahead `sending` claim on `draft_id` | Two workers cannot both reach the provider |
| Tamper-evident decisions | SHA-256 hash chain, per-tenant `seq` | Same-millisecond approvals don't falsely report tampering |
| Failed runs don't stall | `sending` → `sent`/`failed` state machine | Runs recover from provider failure |
| Idempotent drafts | Content hash as draft id | Replay writes nothing |
| Approval ordering | Unique `(user_id, seq)` | No false tamper reports at same millisecond |

---

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Database | PostgreSQL (PGlite WASM) | RLS for tenant isolation, real SQL, no mocks |
| Language | TypeScript (strict) | `tsc --noEmit` clean, 16 files |
| Runtime deps | `@electric-sql/pglite`, `@noble/hashes` | Two, both auditable |
| Tests | Vitest | 209 tests, `maxWorkers: 4` |
| CI | GitHub Actions | Node 20/22/24, typecheck + tests + report + gitleaks + SQL drift |
| Deploy | Vercel + GitHub Pages | Live console + static report |

---

## Reproduce every number

```bash
# Install
npm ci

# Typecheck
npx tsc --noEmit

# Tests (boots PostgreSQL in-process, runs shipped SQL + TS)
npm test          # 209 passing

# Console report — reproduces every README number
npm run report    # 96 leads, 8 drafts, 6 approved / 2 rejected, 6 sent
```

**Report output:** 96 leads examined · 8 drafts · 6 approved / 2 rejected · chain verified (8 entries) · 6 sent · bands: 5 hot / 75 warm / 28 cool / 32 cold

---

## What is real vs simulated

| Element | Status | Evidence |
|---------|--------|----------|
| PostgreSQL RLS isolation | Real | `db/ops.sql` runs `FORCE ROW LEVEL SECURITY`; 34 adversarial tests |
| Hash-chained audit ledger | Real | SHA-256 chain in `src/ops/pipeline.ts` |
| Write-ahead send claim | Real | `sending` status before provider call |
| Live console | Real | Boots PGlite WASM, runs shipped pipeline |
| Demo data | Seeded | 140 leads in `db/ops_seed.sql` |
| LLM calls | None | Drafting is deterministic; no model API in the loop |

No simulated engines, no fabricated README numbers. If a number is on this page, `npm run report` or `npm test` produces it.

---

## Security

- Cross-tenant reads enforced at the **database** layer (`FORCE ROW LEVEL SECURITY`), not application code
- Credentials encrypted at rest (AES-GCM vault, `src/ops/vault.ts`)
- Webhook signatures verified (HMAC with replay windows)
- Prompt injection screening on drafted content
- Full audit trail: every decision hash-chained with per-tenant sequence

---

## License

MIT — see [LICENSE](LICENSE).
