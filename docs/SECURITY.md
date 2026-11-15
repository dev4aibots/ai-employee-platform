# Security model

## Assets and threats

| Asset | Why it matters | Primary control |
|---|---|---|
| Tenant documents and conversations | Commercial confidentiality; a leak ends the contract | RLS on every table, `FORCE ROW LEVEL SECURITY` |
| Customer third-party API keys (HubSpot, WhatsApp, Stripe) | Live credentials to someone else's business | AES-256-GCM at rest, AAD-bound to tenant + provider, versioned keyring |
| Billing state (plan, seats, trial) | Direct revenue; self-service upgrade is the classic SaaS hole | `BEFORE UPDATE` trigger rejecting tenant writes to privileged columns |
| Webhook processing | Duplicate charges, duplicate emails | Claim-first idempotency with payload hashing |
| Audit history | Dispute resolution, incident forensics | Hash chain, append-only, no update/delete policy |
| Model spend | Runaway agent loops | Per-tenant token bucket, cost recorded per run |

## Trust boundaries

```
 untrusted                │  semi-trusted            │  trusted
 ─────────────────────────┼──────────────────────────┼──────────────────────
 browser session          │ n8n (internal network)   │ service role
 tenant-supplied documents│ provider webhooks        │ database superuser
 model output             │                          │ KMS / master key
```

Three rules follow:

1. **Model output is untrusted input.** Retrieved context and model replies never reach a SQL string, a shell, or a URL without validation.
2. **Webhooks are authenticated, not trusted.** A valid signature proves origin, not correctness. Payloads are still schema-validated and idempotency-keyed.
3. **The service role is the only writer of billing and audit rows.** Tenant sessions can read their own history and nothing else.

## Controls in detail

### Tenancy
RLS is enabled *and forced* on all eight tables. `FORCE` matters because without it the table owner silently bypasses policies — a very common way RLS ends up decorative. `anon` holds no table grants at all, so an unauthenticated request fails at the privilege layer before RLS is even consulted.

The `messages` insert policy checks two things, not one: that `user_id` is the caller, **and** that `employee_id` belongs to the caller. Checking only `user_id` allows a cross-tenant reference where the row looks owned but points at someone else's data.

### Credentials
- AES-256-GCM, 96-bit random IV per write, 128-bit tag.
- Key derived per version via `scrypt(masterKey, "ai-employee-platform/vault/v<n>")`.
- `userId` + `provider` bound as associated data. A row moved between tenants fails authentication.
- Rotation: add a version to `VAULT_KEY_VERSIONS`, `needsRotation()` finds stragglers, `rotate()` re-encrypts.
- No default key. A missing `VAULT_MASTER_KEY` is a startup failure (`VaultError`), not a silent constant.
- Secrets are never logged. The demo prints a ciphertext prefix, never the master key.

### Privilege escalation
Policies decide rows; they do not decide columns. A tenant may update its own `profiles` row, so without a guard it could set `plan='scale'`, `seats=500`, `is_superadmin=true`, or `trial_ends_at=now()+10 years`. The `guard_profile_privileges()` trigger compares old against new and raises `42501`. Six escalation attempts are asserted in `tests/rls.test.ts`.

### Webhooks
- HMAC-SHA256 over `"<timestamp>.<raw body>"`, compared with `timingSafeEqual` on equal-length buffers (length mismatch is rejected first, so `timingSafeEqual` cannot throw).
- ±300 s default skew window, configurable, rejected outside.
- Idempotency key is the table primary key: one winner, every replay a no-op.
- Same key with a different body is a `conflict`, not a duplicate — that is either a provider bug or tampering.

### Outbound dispatch
Requests are signed so n8n can verify them, carry `x-tenant-id` and `x-idempotency-key`, and retry only 408/425/429/5xx. A 4xx is our bug and retrying it wastes quota. The circuit breaker converts a slow dependency into a fast, observable rejection.

### Audit
`entry_hash = sha256(prev_hash ‖ seq ‖ userId ‖ actor ‖ action ‖ subject ‖ canonical_json(payload) ‖ createdAt)`. Canonical JSON sorts keys and rejects non-finite numbers, so the same logical payload always hashes identically. `verifyChain` reports the first broken index.

Truncation is not detectable from the chain alone — a shortened chain is internally consistent. That is why the head hash must be published out of band; `tests/audit.test.ts` asserts exactly this.

## Known gaps

Stated plainly, because a security page that claims completeness is a red flag.

1. **No KMS.** The master key is an environment variable. Production should wrap a per-tenant data key with a KMS/HSM.
2. **No key-rotation automation.** `rotate()` exists and is tested; nothing schedules it.
3. **No audit-chain anchoring.** The head hash is not yet written to an external append-only store.
4. **Rate limiting is in-process.** Multiple instances multiply the effective limit.
5. **No prompt-injection defence in this repo.** Retrieved documents are untrusted; screening them is a separate module and is not implemented here.
6. **No SBOM or dependency scanning in CI.** Planned.
7. **Timing side channels** are addressed for signature comparison only; other comparisons are not constant-time.
8. **No penetration test.** The suite is adversarial but it was written by the same person who wrote the code.

## Reporting

Security issues: `hello@dev4aibots.com`. Please do not open a public issue for anything exploitable.
