import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TENANT_A, TENANT_B, type Harness } from '../src/db/harness.js';
import { decideApproval, runSalesWorkflow, sendDraft } from '../src/ops/pipeline.js';

/**
 * Adversarial tests for the operations tables.
 *
 * Tenant A owns 140 leads. Tenant B owns nothing. Every test below is an
 * attempt by B - or by an anonymous visitor - to reach A's pipeline. If a
 * policy in db/ops.sql regresses, at least one of these turns red.
 */

let h: Harness;
let aDraftId: string;

beforeAll(async () => {
  h = await createHarness();

  await h.asTenant(TENANT_A, (q) =>
    runSalesWorkflow({ db: q, now: () => new Date(), sleep: async () => undefined }, {
      userId: TENANT_A,
      goal: 'seed one draft for the isolation tests',
      limit: 1,
    }),
  );

  const draft = await h.asService((q) =>
    q.query<{ id: string }>(`select id from drafts where user_id = $1 limit 1`, [TENANT_A]),
  );
  aDraftId = draft.rows[0]!.id;
});

afterAll(async () => {
  await h.close();
});

describe('tenant isolation on the operations tables', () => {
  it('tenant B sees none of tenant A leads', async () => {
    const aCount = await h.asTenant(TENANT_A, (q) =>
      q.query<{ n: string }>(`select count(*)::text as n from leads`),
    );
    const bCount = await h.asTenant(TENANT_B, (q) =>
      q.query<{ n: string }>(`select count(*)::text as n from leads`),
    );
    expect(Number(aCount.rows[0]?.n)).toBe(140);
    expect(Number(bCount.rows[0]?.n)).toBe(0);
  });

  it('tenant B cannot read tenant A drafts, approvals, sends or runs', async () => {
    for (const table of ['drafts', 'approvals', 'sends', 'ops_runs', 'ops_run_steps', 'lead_signals']) {
      const result = await h.asTenant(TENANT_B, (q) =>
        q.query<{ n: string }>(`select count(*)::text as n from ${table}`),
      );
      expect(Number(result.rows[0]?.n), `${table} leaked to tenant B`).toBe(0);
    }
  });

  it('tenant B cannot write a row owned by tenant A', async () => {
    await expect(
      h.asTenant(TENANT_B, (q) =>
        q.query(
          `insert into leads (user_id, company, domain, contact_name, contact_role, contact_email, source)
           values ($1, 'Forged Co', 'forged.example', 'Attacker', 'CEO', 'a@forged.example', 'inbound')`,
          [TENANT_A],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/);
  });

  it('tenant B cannot mutate tenant A leads even with a valid id', async () => {
    const target = await h.asService((q) =>
      q.query<{ id: string }>(`select id from leads where user_id = $1 limit 1`, [TENANT_A]),
    );
    const updated = await h.asTenant(TENANT_B, (q) =>
      q.query(`update leads set stage = 'won' where id = $1`, [target.rows[0]!.id]),
    );
    expect(updated.rows).toHaveLength(0);

    const stillThere = await h.asService((q) =>
      q.query<{ stage: string }>(`select stage from leads where id = $1`, [target.rows[0]!.id]),
    );
    expect(stillThere.rows[0]?.stage).not.toBe('won');
  });

  it('tenant B cannot approve or send tenant A drafts', async () => {
    const deps = { db: null as never, now: () => new Date() };

    await expect(
      h.asTenant(TENANT_B, (q) =>
        decideApproval({ ...deps, db: q }, { userId: TENANT_B, draftId: aDraftId, decision: 'approved', actor: 'b' }),
      ),
    ).rejects.toThrow(/not found for this tenant/);

    await expect(
      h.asTenant(TENANT_B, (q) => sendDraft({ ...deps, db: q }, { userId: TENANT_B, draftId: aDraftId, actor: 'b' })),
    ).rejects.toThrow(/not found for this tenant/);
  });

  it('anonymous visitors are denied at the grant level', async () => {
    for (const table of ['leads', 'drafts', 'approvals', 'sends', 'ops_runs']) {
      await expect(
        h.asAnon((q) => q.query(`select * from ${table}`)),
        `${table} was readable by anon`,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('the pipeline view obeys the caller, not its owner', async () => {
    const a = await h.asTenant(TENANT_A, (q) =>
      q.query<{ total: number }>(`select total from lead_pipeline`),
    );
    const b = await h.asTenant(TENANT_B, (q) =>
      q.query<{ total: number }>(`select total from lead_pipeline`),
    );
    expect(Number(a.rows[0]?.total)).toBe(140);
    expect(b.rows).toHaveLength(0);
  });

  it('service role is the only path that sees across tenants', async () => {
    const all = await h.asService((q) =>
      q.query<{ n: string }>(`select count(distinct user_id)::text as n from leads`),
    );
    expect(Number(all.rows[0]?.n)).toBe(1);
  });
});
