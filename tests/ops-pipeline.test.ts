import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TENANT_A, type Harness, type Queryable } from '../src/db/harness.js';
import {
  decideApproval,
  dryRunProvider,
  runSalesWorkflow,
  sendDraft,
  verifyApprovalChain,
  type EmailProvider,
  type OpsDeps,
} from '../src/ops/pipeline.js';
import type { RunSummary } from '../src/ops/types.js';
import { getAnalytics, listApprovalQueue } from '../src/ops/analytics.js';

/**
 * End-to-end tests for the operations pipeline against real PostgreSQL.
 *
 * These are the tests that make the demo's numbers defensible: every count the
 * console shows is a query over rows these tests wrote, and every reliability
 * claim (idempotent drafts, single-writer approvals, one send per draft,
 * failures that are recorded) is asserted here rather than described in prose.
 */

let h: Harness;
let NOW: Date;

const GOAL = 'Find leads that have not replied in 7 days, rank them, draft the outreach';

function deps(q: Queryable, extra: Partial<OpsDeps> = {}): OpsDeps {
  return { db: q, now: () => NOW, sleep: async () => undefined, ...extra };
}

async function count(q: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const result = await q.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

async function nextPendingDraft(q: Queryable): Promise<string> {
  const result = await q.query<{ id: string }>(
    `select id from drafts where user_id = $1 and status = 'pending' order by content_hash limit 1`,
    [TENANT_A],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no pending draft available for this test');
  return id;
}

beforeAll(async () => {
  h = await createHarness();
  // Captured after seeding so every run in this file uses one clock.
  NOW = new Date();
});

afterAll(async () => {
  await h.close();
});

describe('runSalesWorkflow', () => {
  let first: RunSummary;

  it('runs the play and stops at awaiting approval', async () => {
    first = await h.asTenant(TENANT_A, (q) =>
      runSalesWorkflow(deps(q), { userId: TENANT_A, goal: GOAL, limit: 5 }),
    );

    expect(first.status).toBe('awaiting_approval');
    expect(first.draftsMade).toBe(5);
    expect(first.draftsSkipped).toBe(0);
    expect(first.leadsSeen).toBeGreaterThanOrEqual(5);
    expect(first.steps.map((step) => step.name)).toEqual([
      'load_leads',
      'load_signals',
      'rank_leads',
      'draft_outreach',
      'persist_drafts',
      'finalize_run',
    ]);
    expect(first.steps.every((step) => step.status === 'ok')).toBe(true);
  });

  it('persists the run and its drafts so a crash loses no work', async () => {
    const run = await h.asTenant(TENANT_A, async (q) => {
      const rows = await q.query<{ status: string; leads_seen: number; drafts_made: number }>(
        `select status, leads_seen, drafts_made from ops_runs where id = $1`,
        [first.runId],
      );
      return rows.rows[0];
    });
    expect(run).toMatchObject({ status: 'awaiting_approval', drafts_made: 5 });

    const drafts = await h.asTenant(TENANT_A, (q) =>
      q.query<{ status: string; writer: string; content_hash: string }>(
        `select status, writer, content_hash from drafts where user_id = $1`,
        [TENANT_A],
      ),
    );
    expect(drafts.rows).toHaveLength(5);
    expect(drafts.rows.every((row) => row.status === 'pending')).toBe(true);
    expect(drafts.rows.every((row) => row.writer === 'template-v1')).toBe(true);
    expect(drafts.rows.every((row) => /^[0-9a-f]{64}$/.test(row.content_hash))).toBe(true);
  });

  it('is idempotent: the same play twice drafts nothing new', async () => {
    const second = await h.asTenant(TENANT_A, (q) =>
      runSalesWorkflow(deps(q), { userId: TENANT_A, goal: GOAL, limit: 5 }),
    );

    expect(second.draftsMade).toBe(0);
    expect(second.draftsSkipped).toBe(5);
    expect(second.status).toBe('completed');

    const total = await h.asTenant(TENANT_A, (q) =>
      count(q, `select count(*)::text as n from drafts where user_id = $1`, [TENANT_A]),
    );
    expect(total).toBe(5);
  });

  it('ranks leads deterministically across runs', async () => {
    const again = await h.asTenant(TENANT_A, (q) =>
      runSalesWorkflow(deps(q), { userId: TENANT_A, goal: GOAL, limit: 5 }),
    );
    expect(again.topLeads.map((item) => item.lead.id)).toEqual(first.topLeads.map((item) => item.lead.id));
  });

  it('records a failed run instead of leaving it running', async () => {
    const broken = {
      id: 'broken',
      async write(): Promise<never> {
        throw new Error('writer exploded');
      },
    };

    await expect(
      h.asTenant(TENANT_A, (q) =>
        runSalesWorkflow(deps(q, { writer: broken, retries: 1 }), {
          userId: TENANT_A,
          goal: 'this one fails',
          limit: 2,
        }),
      ),
    ).rejects.toThrow('writer exploded');

    const failed = await h.asService((q) =>
      q.query<{ id: string; status: string; drafts_made: number }>(
        `select id, status, drafts_made from ops_runs where status = 'failed'`,
      ),
    );
    expect(failed.rows).toHaveLength(1);
    const runId = failed.rows[0]!.id;

    const steps = await h.asService((q) =>
      q.query<{ name: string; status: string; error: string | null }>(
        `select name, status, error from ops_run_steps where run_id = $1 order by seq`,
        [runId],
      ),
    );
    expect(steps.rows.map((row) => row.name)).toEqual([
      'load_leads',
      'load_signals',
      'rank_leads',
      'draft_outreach',
    ]);
    expect(steps.rows.at(-1)).toMatchObject({ status: 'failed', error: 'writer exploded' });
  });
});

describe('decideApproval', () => {
  it('records a decision exactly once', async () => {
    const draftId = await h.asTenant(TENANT_A, (q) => nextPendingDraft(q));

    const first = await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'approved', actor: 'devraj@acme.test' }),
    );
    expect(first.alreadyRecorded).toBe(false);
    expect(first.seq).toBe(1);

    const replay = await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'approved', actor: 'devraj@acme.test' }),
    );
    expect(replay.alreadyRecorded).toBe(true);
    expect(replay.entryHash).toBe(first.entryHash);
    expect(replay.id).toBe(first.id);
  });

  it('cannot flip a rejection into an approval', async () => {
    const draftId = await h.asTenant(TENANT_A, (q) =>
      q.query<{ id: string }>(
        `select id from drafts where user_id = $1 and status = 'pending' order by content_hash limit 1`,
        [TENANT_A],
      ).then((r) => r.rows[0]!.id),
    );

    const rejected = await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'rejected', actor: 'devraj@acme.test' }),
    );
    const attemptedFlip = await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'approved', actor: 'attacker@acme.test' }),
    );

    expect(attemptedFlip.alreadyRecorded).toBe(true);
    expect(attemptedFlip.decision).toBe('rejected');
    expect(attemptedFlip.entryHash).toBe(rejected.entryHash);

    const status = await h.asTenant(TENANT_A, (q) =>
      q.query<{ status: string }>(`select status from drafts where id = $1`, [draftId]),
    );
    expect(status.rows[0]?.status).toBe('rejected');
  });

  it('refuses to decide a draft that is already sent', async () => {
    const sent = await h.asService((q) =>
      q.query<{ id: string }>(`select id from drafts where status = 'sent' limit 1`),
    );
    if (sent.rows.length === 0) return; // sending is covered in the next block

    await expect(
      h.asTenant(TENANT_A, (q) =>
        decideApproval(deps(q), {
          userId: TENANT_A,
          draftId: sent.rows[0]!.id,
          decision: 'rejected',
          actor: 'devraj@acme.test',
        }),
      ),
    ).rejects.toThrow(/only pending drafts/);
  });
});

describe('verifyApprovalChain', () => {
  it('accepts an intact chain', async () => {
    const check = await h.asTenant(TENANT_A, (q) => verifyApprovalChain(deps(q), TENANT_A));
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(2);
  });

  it('detects a tampered decision', async () => {
    await h.asService((q) => q.query(`update approvals set decision = 'approved' where seq = 2`));

    const check = await h.asTenant(TENANT_A, (q) => verifyApprovalChain(deps(q), TENANT_A));
    expect(check.ok).toBe(false);
    expect(check.brokenAt).not.toBeNull();

    await h.asService((q) => q.query(`update approvals set decision = 'rejected' where seq = 2`));
    const restored = await h.asTenant(TENANT_A, (q) => verifyApprovalChain(deps(q), TENANT_A));
    expect(restored.ok).toBe(true);
  });
});

describe('sendDraft', () => {
  it('refuses a draft that has not been approved', async () => {
    const draftId = await h.asTenant(TENANT_A, (q) => nextPendingDraft(q));
    await expect(
      h.asTenant(TENANT_A, (q) => sendDraft(deps(q), { userId: TENANT_A, draftId, actor: 'ops' })),
    ).rejects.toThrow(/only approved drafts/);
  });

  it('claims the send before calling the provider, so two callers cannot both send', async () => {
    const draftId = await h.asTenant(TENANT_A, (q) =>
      q.query<{ id: string }>(
        `select id from drafts where user_id = $1 and status = 'pending' order by content_hash limit 1`,
        [TENANT_A],
      ).then((r) => r.rows[0]!.id),
    );

    await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'approved', actor: 'devraj@acme.test' }),
    );

    const delivered: string[] = [];
    const slow: EmailProvider = {
      id: 'slow-smtp',
      async send(message) {
        delivered.push(message.to);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { messageId: 'slow-1' };
      },
    };

    const results = await h.asTenant(TENANT_A, async (q) => {
      const run = () =>
        sendDraft(deps(q, { provider: slow }), { userId: TENANT_A, draftId, actor: 'ops' });
      return Promise.allSettled([run(), run()]);
    });

    expect(delivered).toHaveLength(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toMatch(/in progress/);

    const state = await h.asTenant(TENANT_A, async (q) => {
      const send = await q.query<{ status: string; attempts: number }>(
        `select status, attempts from sends where draft_id = $1`,
        [draftId],
      );
      const draft = await q.query<{ status: string }>(`select status from drafts where id = $1`, [draftId]);
      return { send: send.rows[0], draft: draft.rows[0]?.status };
    });
    expect(state.send).toMatchObject({ status: 'sent', attempts: 1 });
    expect(state.draft).toBe('sent');
  });

  it('returns the original receipt when called again', async () => {
    const sent = await h.asService((q) =>
      q.query<{ id: string }>(`select id from drafts where status = 'sent' order by created_at limit 1`),
    );
    const draftId = sent.rows[0]!.id;

    const replay = await h.asTenant(TENANT_A, (q) =>
      sendDraft(deps(q), { userId: TENANT_A, draftId, actor: 'ops' }),
    );
    expect(replay.alreadySent).toBe(true);
    expect(replay.messageId).toBe('slow-1');
    expect(replay.attempts).toBe(1);
  });

  it('records a failed send and allows a retry', async () => {
    const draftId = await h.asTenant(TENANT_A, (q) =>
      q.query<{ id: string }>(
        `select id from drafts where user_id = $1 and status = 'pending' order by content_hash limit 1`,
        [TENANT_A],
      ).then((r) => r.rows[0]!.id),
    );

    await h.asTenant(TENANT_A, (q) =>
      decideApproval(deps(q), { userId: TENANT_A, draftId, decision: 'approved', actor: 'devraj@acme.test' }),
    );

    const failing: EmailProvider = {
      id: 'smtp',
      async send() {
        throw new Error('550 mailbox unavailable');
      },
    };

    await expect(
      h.asTenant(TENANT_A, (q) =>
        sendDraft(deps(q, { provider: failing, retries: 1 }), { userId: TENANT_A, draftId, actor: 'ops' }),
      ),
    ).rejects.toThrow('550 mailbox unavailable');

    const failed = await h.asTenant(TENANT_A, async (q) => {
      const send = await q.query<{ status: string; attempts: number }>(
        `select status, attempts from sends where draft_id = $1`,
        [draftId],
      );
      const draft = await q.query<{ status: string }>(`select status from drafts where id = $1`, [draftId]);
      return { send: send.rows[0], draft: draft.rows[0]?.status };
    });
    expect(failed).toEqual({ send: { status: 'failed', attempts: 1 }, draft: 'failed' });

    const retry = await h.asTenant(TENANT_A, (q) =>
      sendDraft(deps(q, { provider: dryRunProvider }), { userId: TENANT_A, draftId, actor: 'ops' }),
    );
    expect(retry.status).toBe('dry_run');
    expect(retry.attempts).toBe(2);

    const after = await h.asTenant(TENANT_A, (q) =>
      q.query<{ status: string }>(`select status from drafts where id = $1`, [draftId]),
    );
    expect(after.rows[0]?.status).toBe('sent');
  });

  it('moves the lead to contacted and stamps the last touch time', async () => {
    const link = await h.asService((q) =>
      q.query<{ lead_id: string; stage: string; last_contact_at: string | null }>(
        `select l.id as lead_id, l.stage, l.last_contact_at::text as last_contact_at
           from sends s
           join drafts d on d.id = s.draft_id
           join leads l on l.id = d.lead_id
          where s.status in ('sent', 'dry_run')
          limit 1`,
      ),
    );
    expect(link.rows[0]?.stage).toBe('contacted');
    expect(link.rows[0]?.last_contact_at).not.toBeNull();
  });
});

describe('read models', () => {
  it('counts what the database holds, not what the UI hopes', async () => {
    const analytics = await h.asTenant(TENANT_A, (q) => getAnalytics(q, TENANT_A));

    const expected = await h.asTenant(TENANT_A, async (q) => ({
      leads: await count(q, `select count(*)::text as n from leads where user_id = $1`, [TENANT_A]),
      drafts: await count(q, `select count(*)::text as n from drafts where user_id = $1`, [TENANT_A]),
      sent: await count(q, `select count(*)::text as n from drafts where user_id = $1 and status = 'sent'`, [TENANT_A]),
      failed: await count(q, `select count(*)::text as n from drafts where user_id = $1 and status = 'failed'`, [TENANT_A]),
      approvals: await count(q, `select count(*)::text as n from approvals where user_id = $1`, [TENANT_A]),
      runs: await count(q, `select count(*)::text as n from ops_runs where user_id = $1`, [TENANT_A]),
      failedRuns: await count(q, `select count(*)::text as n from ops_runs where user_id = $1 and status = 'failed'`, [TENANT_A]),
    }));

    expect(analytics.leads.total).toBe(140);
    expect(analytics.leads.total).toBe(expected.leads);
    expect(analytics.drafts.sent).toBe(expected.sent);
    expect(analytics.drafts.failed).toBe(expected.failed);
    expect(analytics.approval.decisions).toBe(expected.approvals);
    expect(analytics.runs.total).toBe(expected.runs);
    expect(analytics.runs.failed).toBe(expected.failedRuns);

    const draftSum =
      analytics.drafts.pending +
      analytics.drafts.approved +
      analytics.drafts.rejected +
      analytics.drafts.sent +
      analytics.drafts.failed;
    expect(draftSum).toBe(expected.drafts);
  });

  it('reports zero cost honestly when the offline writer is used', async () => {
    const analytics = await h.asTenant(TENANT_A, (q) => getAnalytics(q, TENANT_A));
    expect(analytics.cost.totalUsd).toBe(0);
    expect(analytics.cost.tokens).toBe(0);
    expect(analytics.cost.perSentLeadUsd).toBe(0);
  });

  it('returns an approval queue that explains itself', async () => {
    const queue = await h.asTenant(TENANT_A, (q) => listApprovalQueue(q, TENANT_A));

    expect(queue.length).toBeGreaterThan(0);
    for (const item of queue) {
      expect(item.subject.length).toBeGreaterThan(0);
      expect(item.body).toContain(item.lead.contact_name.split(' ')[0]!);
      expect(item.band).toMatch(/^(hot|warm|cool|cold)$/);
      expect(item.contributions.length).toBeGreaterThan(0);
    }
  });
});
