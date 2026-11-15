/**
 * Operations report.
 *
 * Runs the real pipeline against the 140-lead fixture, makes a day's worth of
 * decisions, sends the approved drafts through the dry-run provider, and prints
 * what the database actually holds. Every number below is a query result, not a
 * projection - this is the same source the README quotes.
 *
 *   npm run report
 */

import { createHarness, TENANT_A } from '../db/harness.js';
import { decideApproval, runSalesWorkflow, sendDraft, verifyApprovalChain } from '../ops/pipeline.js';
import { getAnalytics, listApprovalQueue, listRuns } from '../ops/analytics.js';

const GOAL = 'Find leads that have not replied in 7 days, rank them, draft the outreach';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function main(): Promise<void> {
  const started = Date.now();
  const h = await createHarness();
  const clock = new Date();

  try {
    const run = await h.asTenant(TENANT_A, (q) =>
      runSalesWorkflow({ db: q, now: () => clock, sleep: async () => undefined }, {
        userId: TENANT_A,
        goal: GOAL,
        limit: 8,
      }),
    );

    const queue = await h.asTenant(TENANT_A, (q) => listApprovalQueue(q, TENANT_A));
    const ordered = [...queue].sort((a, b) => a.draftId.localeCompare(b.draftId));
    const approve = ordered.slice(0, 6);
    const reject = ordered.slice(6);

    for (const item of approve) {
      await h.asTenant(TENANT_A, (q) =>
        decideApproval({ db: q, now: () => clock }, {
          userId: TENANT_A,
          draftId: item.draftId,
          decision: 'approved',
          actor: 'devraj@acme.test',
        }),
      );
    }
    for (const item of reject) {
      await h.asTenant(TENANT_A, (q) =>
        decideApproval({ db: q, now: () => clock }, {
          userId: TENANT_A,
          draftId: item.draftId,
          decision: 'rejected',
          actor: 'devraj@acme.test',
          note: 'wrong buyer profile',
        }),
      );
    }

    const sends = [];
    for (const item of approve) {
      sends.push(
        await h.asTenant(TENANT_A, (q) =>
          sendDraft({ db: q, now: () => clock }, { userId: TENANT_A, draftId: item.draftId, actor: 'devraj@acme.test' }),
        ),
      );
    }

    const chain = await h.asTenant(TENANT_A, (q) => verifyApprovalChain({ db: q }, TENANT_A));
    const analytics = await h.asTenant(TENANT_A, (q) => getAnalytics(q, TENANT_A));
    const runs = await h.asTenant(TENANT_A, (q) => listRuns(q, TENANT_A, 5));
    const latencies = run.steps.map((step) => step.latencyMs);

    const lines: string[] = [];
    lines.push('');
    lines.push('ai-employee-platform :: operations report');
    lines.push(`fixture   db/ops_seed.sql (140 leads, 2 tenants, deterministic)`);
    lines.push(`clock     ${clock.toISOString()}`);
    lines.push('');
    lines.push(`PLAY  ${GOAL}`);
    lines.push(`  leads examined      ${pad(run.leadsSeen, 5)}`);
    lines.push(`  drafts created      ${pad(run.draftsMade, 5)}`);
    lines.push(`  drafts skipped      ${pad(run.draftsSkipped, 5)}   (content hash already present)`);
    lines.push(`  tokens / cost       ${pad(run.tokens, 5)} / $${run.costUsd.toFixed(6)}   (offline writer, no model call)`);
    lines.push(
      `  step latency        p50 ${percentile(latencies, 50)} ms   p95 ${percentile(latencies, 95)} ms`,
    );
    lines.push('');
    lines.push('DECISIONS');
    lines.push(`  approved            ${pad(analytics.approval.approved, 5)}`);
    lines.push(`  rejected            ${pad(analytics.approval.rejected, 5)}`);
    lines.push(
      `  chain               ${chain.ok ? 'verified' : `BROKEN at ${chain.brokenAt}`} (${chain.checked} entries)`,
    );
    lines.push('');
    lines.push('SENDS');
    lines.push(`  sent                ${pad(analytics.drafts.sent, 5)}   (provider: dry-run)`);
    lines.push(`  failed              ${pad(analytics.drafts.failed, 5)}`);
    lines.push(`  provider receipts   ${pad(new Set(sends.map((s) => s.messageId)).size, 5)} unique`);
    lines.push('');
    lines.push('PIPELINE');
    lines.push(
      `  leads               ${pad(analytics.leads.total, 5)}   qualified ${analytics.leads.qualified}   contacted ${analytics.leads.contacted}   replied ${analytics.leads.replied}`,
    );
    lines.push(
      `  queue               ${pad(analytics.drafts.pending, 5)} pending   decisions per draft ${pct(analytics.approval.interventionRate)}`,
    );
    lines.push(
      `  runs                ${pad(analytics.runs.total, 5)}   success ${pct(analytics.runs.successRate)}   failed ${analytics.runs.failed}`,
    );
    lines.push(
      `  score bands         ${analytics.scores.hot} hot   ${analytics.scores.warm} warm   ${analytics.scores.cool} cool   ${analytics.scores.cold} cold   avg ${analytics.scores.average.toFixed(1)}`,
    );
    lines.push('');
    lines.push('SOURCES');
    for (const source of analytics.sources) {
      lines.push(
        `  ${source.source.padEnd(10)} leads ${pad(source.leads, 4)}   replies ${pad(source.replies, 4)}   reply rate ${pct(source.replyRate)}`,
      );
    }
    lines.push('');
    lines.push('RUN LEDGER');
    for (const item of runs) {
      lines.push(
        `  ${item.id.slice(0, 8)}  ${item.status.padEnd(17)} leads ${pad(item.leadsSeen, 4)}  drafts ${pad(item.draftsMade, 3)}  $${item.costUsd.toFixed(6)}`,
      );
    }
    lines.push('');
    lines.push(`NOTE  Fixture numbers from db/ops_seed.sql, not customer data.`);
    lines.push(`      Reproduce with: npm run report   (${Date.now() - started} ms)`);
    lines.push('');

    console.log(lines.join('\n'));

    if (!chain.ok) process.exitCode = 1;
  } finally {
    await h.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
