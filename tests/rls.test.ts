import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  DOC_B,
  EMPLOYEE_A,
  EMPLOYEE_B,
  TENANT_A,
  TENANT_B,
  type Harness,
} from '../src/db/harness.js';

/**
 * Adversarial tenancy suite.
 *
 * Every test here is written from the perspective of an attacker who already
 * holds a valid session for tenant A and wants tenant B's data. A regression in
 * db/policies.sql must turn at least one of these red, otherwise the suite is
 * decoration.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('reads', () => {
  it('tenant A sees only its own documents', async () => {
    const rows = await h.asTenant(TENANT_A, (q) =>
      q.query<{ user_id: string; title: string }>('select user_id, title from documents'),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(new Set(rows.rows.map((r) => r.user_id))).toEqual(new Set([TENANT_A]));
  });

  it('tenant A cannot fetch tenant B document by primary key', async () => {
    const rows = await h.asTenant(TENANT_A, (q) =>
      q.query('select * from documents where id = $1', [DOC_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('tenant A cannot read tenant B employees', async () => {
    const rows = await h.asTenant(TENANT_A, (q) =>
      q.query('select * from employees where id = $1', [EMPLOYEE_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('tenant A cannot read tenant B profile', async () => {
    const rows = await h.asTenant(TENANT_A, (q) =>
      q.query('select email, plan from profiles where id = $1', [TENANT_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('tenant A cannot read tenant B conversation history', async () => {
    const rows = await h.asTenant(TENANT_A, (q) =>
      q.query('select * from messages where user_id = $1', [TENANT_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('an unauthenticated visitor cannot read any tenant table', async () => {
    const tables = ['documents', 'employees', 'profiles', 'messages', 'workflow_runs'];
    for (const table of tables) {
      // anon holds no table grants AND no permissive policy, so the only two
      // acceptable outcomes are "permission denied" or "zero rows".
      const rows = await h.asAnon(async (q) => {
        try {
          const result = await q.query(`select * from ${table}`);
          return result.rows;
        } catch (error) {
          expect(String(error)).toMatch(/permission denied/);
          return [];
        }
      });
      expect(rows, `anon must not read ${table}`).toHaveLength(0);
    }
  });

  it('grants no table privileges to the anon role', async () => {
    const result = await h.asService((q) =>
      q.query<{ count: string }>(
        `select count(*)::text as count from information_schema.role_table_grants
         where grantee = 'anon' and table_schema = 'public'`,
      ),
    );
    expect(Number(result.rows[0]!.count)).toBe(0);
  });

  it('webhook receipts are invisible to tenants because there is no policy', async () => {
    await h.asService((q) =>
      q.query(
        `insert into webhook_receipts (idempotency_key, provider, event_id, payload_sha256)
         values ('probe:1', 'stripe', 'probe-1', 'deadbeef') on conflict do nothing`,
      ),
    );
    const rows = await h.asTenant(TENANT_A, (q) => q.query('select * from webhook_receipts'));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('writes', () => {
  it('tenant A cannot insert a document owned by tenant B', async () => {
    await expect(
      h.asTenant(TENANT_A, (q) =>
        q.query(`insert into documents (user_id, title, content) values ($1, 'forged', 'forged')`, [
          TENANT_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenant A cannot insert an employee owned by tenant B', async () => {
    await expect(
      h.asTenant(TENANT_A, (q) =>
        q.query(`insert into employees (user_id, kind, name) values ($1, 'support', 'ghost')`, [
          TENANT_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenant A cannot attach a message to tenant B employee', async () => {
    await expect(
      h.asTenant(TENANT_A, (q) =>
        q.query(
          `insert into messages (user_id, employee_id, role, content)
           values ($1, $2, 'user', 'cross tenant reference')`,
          [TENANT_A, EMPLOYEE_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenant A can attach a message to its own employee', async () => {
    const inserted = await h.asTenant(TENANT_A, (q) =>
      q.query<{ id: string }>(
        `insert into messages (user_id, employee_id, role, content)
         values ($1, $2, 'user', 'legitimate message') returning id`,
        [TENANT_A, EMPLOYEE_A],
      ),
    );
    expect(inserted.rows).toHaveLength(1);
  });

  it('tenant A cannot update tenant B documents, and no rows change', async () => {
    const result = await h.asTenant(TENANT_A, (q) =>
      q.query(`update documents set content = 'pwned' where id = $1`, [DOC_B]),
    );
    expect(result.rows).toHaveLength(0);

    const bView = await h.asService((q) =>
      q.query<{ content: string }>('select content from documents where id = $1', [DOC_B]),
    );
    expect(bView.rows[0]?.content).not.toBe('pwned');
  });

  it('tenant A cannot delete tenant B documents', async () => {
    await h.asTenant(TENANT_A, (q) => q.query('delete from documents where id = $1', [DOC_B]));
    const stillThere = await h.asService((q) =>
      q.query('select id from documents where id = $1', [DOC_B]),
    );
    expect(stillThere.rows).toHaveLength(1);
  });

  it('tenant A cannot create a profile for itself (signup is service-role only)', async () => {
    await expect(
      h.asTenant(TENANT_A, (q) =>
        q.query(
          `insert into profiles (id, email) values ('99999999-9999-4999-8999-999999999999', 'x@y.test')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('privilege escalation', () => {
  const attempts: Array<[string, string]> = [
    ['upgrade to scale plan', `update profiles set plan = 'scale' where id = $1`],
    ['grant 500 seats', `update profiles set seats = 500 where id = $1`],
    ['extend trial by a decade', `update profiles set trial_ends_at = now() + interval '10 years' where id = $1`],
    ['self-promote to superadmin', `update profiles set is_superadmin = true where id = $1`],
    ['force status to past_due', `update profiles set status = 'past_due' where id = $1`],
    ['attach an attacker billing customer', `update profiles set billing_customer_id = 'cus_attacker' where id = $1`],
  ];

  for (const [label, sql] of attempts) {
    it(`blocks: ${label}`, async () => {
      await expect(h.asTenant(TENANT_A, (q) => q.query(sql, [TENANT_A]))).rejects.toThrow(
        /privilege_escalation_blocked/,
      );
    });
  }

  it('still allows a tenant to edit harmless profile fields', async () => {
    const result = await h.asTenant(TENANT_A, (q) =>
      q.query(
        `update profiles set company_name = 'Acme Robotics Pvt Ltd' where id = $1 returning company_name`,
        [TENANT_A],
      ),
    );
    expect(result.rows).toHaveLength(1);
  });

  it('allows the service role to change plan because billing lives there', async () => {
    const result = await h.asService((q) =>
      q.query(
        `update profiles set plan = 'scale', seats = 500 where id = $1 returning plan, seats`,
        [TENANT_A],
      ),
    );
    expect(result.rows[0]).toEqual({ plan: 'scale', seats: 500 });

    // restore for later tests
    await h.asService((q) =>
      q.query(`update profiles set plan = 'growth', seats = 5 where id = $1`, [TENANT_A]),
    );
  });
});

describe('audit log immutability', () => {
  it('rejects tenant updates and deletes of audit rows', async () => {
    await h.asService((q) =>
      q.query(
        `insert into audit_log (user_id, actor, action, payload, prev_hash, entry_hash)
         values ($1, 'test', 'seed', '{}'::jsonb, repeat('0',64), repeat('a',64))`,
        [TENANT_A],
      ),
    );

    const updated = await h.asTenant(TENANT_A, (q) =>
      q.query(`update audit_log set action = 'tampered' where user_id = $1`, [TENANT_A]),
    );
    expect(updated.rows).toHaveLength(0);

    await h.asTenant(TENANT_A, (q) => q.query(`delete from audit_log where user_id = $1`, [TENANT_A]));
    const remaining = await h.asService((q) =>
      q.query('select action from audit_log where user_id = $1', [TENANT_A]),
    );
    expect(remaining.rows.every((r) => (r as { action: string }).action !== 'tampered')).toBe(true);
    expect(remaining.rows.length).toBeGreaterThan(0);
  });
});

describe('policy surface', () => {
  it('every tenant table has row level security enabled', async () => {
    const result = await h.asService((q) =>
      q.query<{ relname: string; relrowsecurity: boolean }>(
        `select relname, relrowsecurity from pg_class
         where relnamespace = 'public'::regnamespace and relkind = 'r'`,
      ),
    );
    const insecure = result.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(insecure).toEqual([]);
  });

  it('ships the expected number of policies', async () => {
    const result = await h.asService((q) =>
      q.query<{ count: string }>(`select count(*)::text as count from pg_policies where schemaname = 'public'`),
    );
    expect(Number(result.rows[0]!.count)).toBeGreaterThanOrEqual(9);
  });
});
