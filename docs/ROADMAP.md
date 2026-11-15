# Roadmap

Ordered by what a reviewer would want next, not by what is fun to build.

## Shipped

- [x] **Live browser console.** PGlite boots PostgreSQL in the tab, applies `db/*.sql`, runs the operations pipeline, and renders the queue, the score attribution, the run ledger and the tenancy checks. No server, no keys.
- [x] **Operations pipeline.** Lead selection, attributed scoring, deterministic drafting, approval gate, hash-chained decisions, claimed sends, per-run ledger.
- [x] **Operations report.** `npm run report` reproduces every number the README quotes.

## Next

- [ ] **A real `EmailProvider`.** Gmail or SES behind the existing interface, with the draft id passed as the provider's idempotency key and a reconciliation job for the crash-after-accept window.
- [ ] **An LLM writer with a measured comparison.** Implement `DraftWriter` against a model, then run the same fixed lead set through both writers and score reply-worthiness blind. Until that measurement exists, the template writer stays the default.
- [ ] **HTTP layer.** Thin handlers for the three entry points (inbound webhook, tenant query, dispatch) so the modules are exercised over the wire, with `supertest`-style tests.
- [ ] **`workflow_runs` writer.** Persist the telemetry rows the demo currently computes in memory.
- [ ] **GIN index on `to_tsvector(content)`** plus a 10k-document retrieval benchmark comparing lexical-only, dense-only and fused recall@5.

## Then

- [ ] **KMS-wrapped per-tenant data keys**, with the versioned keyring as the seam.
- [ ] **Redis-backed rate limiter and circuit breaker** so limits hold across instances.
- [ ] **Audit head anchoring** to an external append-only store, plus a `verify` CLI that compares the local chain against the anchor.
- [ ] **`webhook_receipts` partitioning** by month with retention matching each provider's replay window.
- [ ] **Prompt-injection screening** for retrieved documents, with an adversarial corpus and a measured block rate rather than a claim.
- [ ] **OpenTelemetry traces** across dispatch → n8n → LiteLLM.

## Explicitly out of scope

- A hosted SaaS instance.
- Billing UI and Stripe checkout flows.
- Agent prompt engineering. LiteLLM and n8n own that.
- Multi-region deployment.

---

Have a request that belongs on this list? Open an issue with the failure mode you are trying to prevent, not only the feature you want.
