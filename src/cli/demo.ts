/**
 * Live demo. Every line below is printed from real execution — no recorded
 * fixtures, no mocked responses. `npm run demo` is the fastest way to see the
 * platform behave.
 */

import { AuditLedger } from '../audit/ledger.js';
import { verifySignature, signPayload } from '../crypto/hmac.js';
import { Vault } from '../crypto/vault.js';
import { createHarness, DOC_B, EMPLOYEE_B, TENANT_A, TENANT_B } from '../db/harness.js';
import { backoffDelay } from '../gateway/n8n.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { summarizeRuns } from '../telemetry/cost.js';
import { IdempotencyService } from '../webhooks/idempotency.js';
import { resolveAccess } from '../tenancy/access.js';

const rule = (label: string) => console.log(`\n${'─'.repeat(72)}\n${label}\n${'─'.repeat(72)}`);

const h = await createHarness();

// ---------------------------------------------------------------------------
rule('1. Tenant isolation — the same query, two sessions, two answers');

for (const [label, tenant] of [
  ['Acme  ', TENANT_A],
  ['Globex', TENANT_B],
] as const) {
  const rows = await h.asTenant(tenant, (q) =>
    q.query<{ title: string }>('select title from documents order by title'),
  );
  console.log(`  ${label} sees: ${rows.rows.map((r) => r.title).join(' | ')}`);
}

const theft = await h.asTenant(TENANT_A, (q) => q.query('select * from documents where id = $1', [DOC_B]));
const ghostEmployee = await h.asTenant(TENANT_A, (q) =>
  q.query('select * from employees where id = $1', [EMPLOYEE_B]),
);
console.log(`  Acme asking for Globex's document by id  -> ${theft.rows.length} rows returned`);
console.log(`  Acme asking for Globex's employee by id  -> ${ghostEmployee.rows.length} rows returned`);

// ---------------------------------------------------------------------------
rule('2. Privilege escalation — a tenant trying to give itself a better deal');

for (const [label, sql] of [
  ["set plan to 'scale'", `update profiles set plan = 'scale' where id = $1`],
  ['grant 500 seats', `update profiles set seats = 500 where id = $1`],
  ['become superadmin', `update profiles set is_superadmin = true where id = $1`],
] as const) {
  try {
    await h.asTenant(TENANT_A, (q) => q.query(sql, [TENANT_A]));
    console.log(`  ✗ ${label}: ALLOWED (this is a bug)`);
  } catch (error) {
    console.log(`  ✓ ${label}: blocked — ${(error as Error).message.split('_blocked')[0]}`);
  }
}

// ---------------------------------------------------------------------------
rule('3. Access decisions — pure function, injected clock');

const now = new Date('2026-11-15T10:00:00Z');
const cases = [
  { status: 'active', trialEndsAt: '2026-11-01T00:00:00Z', pastDueSince: null },
  { status: 'trialing', trialEndsAt: '2026-11-20T00:00:00Z', pastDueSince: null },
  { status: 'trialing', trialEndsAt: '2026-11-01T00:00:00Z', pastDueSince: null },
  { status: 'past_due', trialEndsAt: '2026-11-01T00:00:00Z', pastDueSince: '2026-11-14T10:00:00Z' },
  { status: 'past_due', trialEndsAt: '2026-11-01T00:00:00Z', pastDueSince: '2026-11-01T10:00:00Z' },
  { status: 'canceled', trialEndsAt: '2026-11-01T00:00:00Z', pastDueSince: null },
] as const;

for (const c of cases) {
  const decision = resolveAccess({
    profile: {
      id: TENANT_A,
      email: 'ops@acme.test',
      plan: 'growth',
      status: c.status,
      trialEndsAt: c.trialEndsAt,
      seats: 15,
      isSuperadmin: false,
      pastDueSince: c.pastDueSince,
    },
    now,
  });
  console.log(
    `  ${c.status.padEnd(9)} -> ${decision.allowed ? 'ALLOW' : 'DENY '} [${decision.code}]  ${decision.reason}`,
  );
}

// ---------------------------------------------------------------------------
rule('4. Credential vault — encryption, tenant binding, rotation');

const secret = 'demo-hubspot-token-not-a-real-value';
const v1 = new Vault({ masterKey: 'demo-master-key-not-a-real-secret' });
const sealed = v1.encrypt(secret, { userId: TENANT_A, provider: 'hubspot' });
console.log(`  plaintext : ${secret}`);
console.log(`  at rest   : ${sealed.ciphertext.slice(0, 52)}…`);
console.log(`  decrypt   : ${v1.decrypt(sealed.ciphertext, { userId: TENANT_A, provider: 'hubspot' })}`);

try {
  v1.decrypt(sealed.ciphertext, { userId: TENANT_B, provider: 'hubspot' });
  console.log('  ✗ tenant B decrypted tenant A secret (this is a bug)');
} catch {
  console.log('  ✓ tenant B cannot decrypt tenant A secret (bound to tenant + provider)');
}

const rotated = new Vault({ masterKey: 'demo-master-key-not-a-real-secret', keyVersions: ['v2', 'v1'] });
const fresh = rotated.rotate(sealed.ciphertext, { userId: TENANT_A, provider: 'hubspot' });
console.log(`  rotation  : ${sealed.ciphertext.slice(0, 2)} -> ${fresh.keyVersion}, value preserved = ${rotated.decrypt(fresh.ciphertext, { userId: TENANT_A, provider: 'hubspot' }) === secret}`);

// ---------------------------------------------------------------------------
rule('5. Webhook idempotency — Stripe retries the same event three times');

const idem = await h.asService(async (q) => {
  const svc = new IdempotencyService(q);
  const payload = { id: 'evt_demo', amount: 4900, currency: 'usd' };
  const first = await svc.claim({ provider: 'stripe', eventId: 'evt_demo', payload });
  const second = await svc.claim({ provider: 'stripe', eventId: 'evt_demo', payload });
  const tampered = await svc.claim({
    provider: 'stripe',
    eventId: 'evt_demo',
    payload: { ...payload, amount: 1 },
  });
  if (first.status === 'claimed') await svc.markProcessed(first.key);
  return { first, second, tampered };
});

console.log(`  delivery 1        -> ${idem.first.status}`);
console.log(`  delivery 2        -> ${idem.second.status} (no second email, no second charge)`);
console.log(`  same key, new body-> ${idem.tampered.status} (${idem.tampered.status === 'conflict' ? (idem.tampered as { reason: string }).reason : ''})`);

// ---------------------------------------------------------------------------
rule('6. Inbound signature verification — replay and tamper');

const secretKey = 'demo-webhook-shared-secret';
const ts = Math.floor(now.getTime() / 1000);
const body = JSON.stringify({ id: 'evt_sig', amount: 4900 });

const good = verifySignature({ secret: secretKey, body, signature: signPayload(secretKey, ts, body), timestamp: ts, toleranceSeconds: 300, now: now.getTime() });
const replayed = verifySignature({ secret: secretKey, body, signature: signPayload(secretKey, ts, body), timestamp: ts - 3600, toleranceSeconds: 300, now: now.getTime() });
const tampered = verifySignature({ secret: secretKey, body: body.replace('4900', '1'), signature: signPayload(secretKey, ts, body), timestamp: ts, toleranceSeconds: 300, now: now.getTime() });

console.log(`  valid signature   -> ok=${good.ok}`);
console.log(`  replayed 1h later -> ok=${replayed.ok} reason=${replayed.reason}`);
console.log(`  body tampered     -> ok=${tampered.ok} reason=${tampered.reason}`);

// ---------------------------------------------------------------------------
rule('7. Hybrid retrieval — exact identifiers next to paraphrase');

await h.asTenant(TENANT_A, (q) =>
  q.query(
    `insert into documents (user_id, title, content, embedding) values
       ($1, 'Bearing kit lookup', 'Replacement bearing kit SKU-8842 ships within 48 hours.', $2::double precision[]),
       ($1, 'Hardware warranty',  'Warranty covers manufacturing defects for two years.', $3::double precision[])
     on conflict do nothing`,
    [TENANT_A, '{0.2,0.2,0.1}', '{0.45,0.45,0.1}'],
  ),
);

const hits = await h.asTenant(TENANT_A, (q) =>
  hybridSearch(q, { queryText: 'refund unused hardware SKU-8842', queryEmbedding: [1, 0, 0], limit: 4 }),
);
for (const hit of hits) {
  console.log(
    `  ${hit.score.toFixed(5)}  lexical=${String(hit.lexicalRank ?? '-').padStart(2)}  vector=${String(hit.vectorRank ?? '-').padStart(2)}  ${hit.title}`,
  );
}
console.log('  (a document ranked by only one arm scores lower — that is RRF doing its job)');

// ---------------------------------------------------------------------------
rule('8. Audit ledger — hash chain and tamper detection');

const ledger = new AuditLedger();
ledger.append({ userId: TENANT_A, actor: 'ops@acme.test', action: 'employee.deploy', subject: 'support-agent', payload: { plan: 'growth' }, createdAt: '2026-11-15T10:00:00.000Z' });
ledger.append({ userId: TENANT_A, actor: 'ops@acme.test', action: 'credential.store', subject: 'hubspot', payload: { provider: 'hubspot' }, createdAt: '2026-11-15T10:01:00.000Z' });
ledger.append({ userId: TENANT_A, actor: 'billing', action: 'plan.change', subject: TENANT_A, payload: { from: 'starter', to: 'growth' }, createdAt: '2026-11-15T10:02:00.000Z' });

console.log(`  entries           : ${ledger.all().length}`);
console.log(`  head hash         : ${ledger.head.slice(0, 24)}…`);
console.log(`  chain valid       : ${AuditLedger.verifyChain(ledger.all()).valid}`);

const forged = ledger.all().map((e) => ({ ...e }));
forged[1] = { ...forged[1]!, payload: { provider: 'stripe' } };
const broken = AuditLedger.verifyChain(forged);
console.log(`  after edit entry 1: valid=${broken.valid} brokenAt=${broken.brokenAt} (${broken.reason})`);

// ---------------------------------------------------------------------------
rule('9. Retry policy — bounded, jittered, deterministic to test');

console.log(`  backoff schedule (no jitter): ${[0, 1, 2, 3, 4].map((a) => backoffDelay(a, { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 5000, jitterRatio: 0 })).join('ms, ')}ms`);

// ---------------------------------------------------------------------------
rule('10. Cost and latency telemetry');

const summary = summarizeRuns([
  { model: 'gpt-4o-mini', promptTokens: 1_200, completionTokens: 180, latencyMs: 420 },
  { model: 'gpt-4o-mini', promptTokens: 900, completionTokens: 120, latencyMs: 380 },
  { model: 'claude-sonnet-4.6', promptTokens: 3_100, completionTokens: 640, latencyMs: 2_400 },
  { model: 'claude-sonnet-4.6', promptTokens: 2_800, completionTokens: 510, latencyMs: 2_100 },
]);
console.log(`  runs            : ${summary.runs}`);
console.log(`  total cost      : $${summary.totalCostUsd.toFixed(6)}`);
console.log(`  latency p50/p95 : ${summary.latencyP50Ms}ms / ${summary.latencyP95Ms}ms`);
console.log(`  cost by model   : ${Object.entries(summary.costByModel).map(([m, c]) => `${m}=$${c.toFixed(6)}`).join(', ')}`);

await h.close();
console.log(`\n${'═'.repeat(72)}\nAll sections executed against a live in-process PostgreSQL.\n${'═'.repeat(72)}`);

