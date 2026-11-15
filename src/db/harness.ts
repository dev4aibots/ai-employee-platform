/**
 * In-process Postgres harness.
 *
 * PGlite is real PostgreSQL compiled to WebAssembly, so the SQL under test is
 * the SQL that ships. No Docker, no service container, no "works in CI only"
 * divergence — `npm test` boots a database in about 300 ms.
 *
 * Tenant impersonation mirrors exactly what Supabase does: set the JWT subject
 * in `request.jwt.claim.sub`, switch to the `authenticated` role, run the query.
 * Because every policy is written against auth.uid(), a passing test here is
 * evidence about production behaviour, not a mock.
 */

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const EMPLOYEE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const EMPLOYEE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
export const DOC_A = 'dddddddd-1111-4111-8111-dddddddddddd';
export const DOC_B = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';

const DB_DIR = new URL('../../db/', import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, DB_DIR), 'utf8');
}

export interface Harness {
  readonly db: PGlite;
  /** Run `fn` with the privileges and identity of one tenant. */
  asTenant<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run `fn` as an unauthenticated visitor. */
  asAnon<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run `fn` with service-role privileges (bypasses RLS). */
  asService<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function resetIdentity(db: PGlite): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.query(`select set_config('app.privileged', 'off', false)`);
}

export interface HarnessOptions {
  /** Apply db/seed.sql. Default true. */
  seed?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await PGlite.create();
  const queryable: Queryable = {
    query: (sql, params) => db.query(sql, params as never) as Promise<{ rows: never[] }>,
  };

  await db.exec(read('schema.sql'));
  await db.exec(read('roles.sql'));
  await db.exec(read('policies.sql'));
  if (options.seed !== false) {
    await db.exec(read('seed.sql'));
  }

  return {
    db,

    async asTenant<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
      await db.exec('set role authenticated');
      try {
        return await fn(queryable);
      } finally {
        await resetIdentity(db);
      }
    },

    async asAnon<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
      await db.exec('set role anon');
      try {
        return await fn(queryable);
      } finally {
        await resetIdentity(db);
      }
    },

    async asService<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      await db.query(`select set_config('app.privileged', 'on', false)`);
      await db.exec('set role service_role');
      try {
        return await fn(queryable);
      } finally {
        await resetIdentity(db);
      }
    },

    async close(): Promise<void> {
      await db.close();
    },
  };
}
