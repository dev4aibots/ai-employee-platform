import { PGlite } from '@electric-sql/pglite';
import { OPS_SEED_SQL, OPS_SQL, POLICIES_SQL, ROLES_SQL, SCHEMA_SQL, SEED_SQL } from './generated/sql';
import {
  decideApproval,
  dryRunProvider,
  runSalesWorkflow,
  sendDraft,
  verifyApprovalChain,
} from '../../src/ops/pipeline';
import {
  getAnalytics,
  getRunSteps,
  listApprovalQueue,
  listRecentDrafts,
  listRuns,
  listScoredLeads,
} from '../../src/ops/analytics';
import type { Queryable } from '../../src/db/harness';
import { renderApp } from './views';
import type { IsolationRow, Model, View } from './types';
import './styles/tokens.css';
import './styles/app.css';

/**
 * Browser console.
 *
 * This is not a mock of the platform: it boots PostgreSQL (PGlite, the real
 * engine compiled to WebAssembly), applies the repository's own SQL files, and
 * calls the same `src/ops` pipeline the Node tests and the report CLI call.
 * Every number rendered comes from a query executed in this tab.
 */

const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';
const GOAL = 'Find leads that have not replied in 7 days, rank them, draft the outreach';
const ACTOR = 'devraj@acme.test';

const TABLES = ['leads', 'lead_signals', 'drafts', 'approvals', 'sends', 'ops_runs', 'ops_run_steps'] as const;
const ISOLATION_SQL = TABLES.map(
  (table) => `select '${table}' as table_name, count(*)::text as n from ${table}`,
).join(' union all ');

const app = document.getElementById('app') as HTMLElement;

const state: Model = {
  stage: 'boot',
  bootStep: 0,
  bootError: null,
  view: 'overview',
  busy: null,
  toast: null,
  analytics: null,
  queue: [],
  drafts: [],
  leads: [],
  runs: [],
  steps: [],
  chain: null,
  isolation: [],
  attack: null,
  selectedLeadId: null,
  selectedDraftId: null,
  selectedRunId: null,
  lastRun: null,
};

let db: PGlite;
let toastToken = 0;

// ---------------------------------------------------------------------------
// Database session helpers
//
// PGlite is one connection, so "who am I" is session state. Two tenant blocks
// must never overlap or the second resets the first's role mid-query. Every
// identity switch therefore goes through this queue.
// ---------------------------------------------------------------------------

let sessionQueue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = sessionQueue.then(fn, fn);
  sessionQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function resetIdentity(): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.query(`select set_config('app.privileged', 'off', false)`);
}

function asTenant<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return serial(async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
    await db.exec('set role authenticated');
    try {
      return await fn({
        query: (sql, params) => db.query(sql, params as never) as Promise<{ rows: never[] }>,
      });
    } finally {
      await resetIdentity();
    }
  });
}

function asAnon<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  return serial(async () => {
    await db.exec('set role anon');
    try {
      return await fn({
        query: (sql, params) => db.query(sql, params as never) as Promise<{ rows: never[] }>,
      });
    } finally {
      await resetIdentity();
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.dataset.action
    ? JSON.stringify({ action: active.dataset.action, id: active.dataset.id ?? '', view: active.dataset.view ?? '' })
    : null;

  app.innerHTML = renderApp(state);

  if (focusKey) {
    const { action, id, view } = JSON.parse(focusKey) as { action: string; id: string; view: string };
    const selector = [
      `[data-action="${action}"]`,
      id ? `[data-id="${id}"]` : '',
      view ? `[data-view="${view}"]` : '',
    ].join('');
    app.querySelector<HTMLElement>(selector)?.focus();
  }

  if (state.selectedLeadId) {
    app.querySelector<HTMLElement>('.drawer [data-action="close-drawer"]')?.focus();
  }
}

function toast(kind: 'ok' | 'bad', text: string): void {
  state.toast = { kind, text };
  const token = ++toastToken;
  setTimeout(() => {
    if (token === toastToken) {
      state.toast = null;
      render();
    }
  }, 6000);
}

function go(view: View): void {
  if (state.view === view) {
    render();
    return;
  }
  // The hash is the router: every view is linkable and the back button works.
  location.hash = view;
}

const VIEWS: View[] = ['overview', 'leads', 'approvals', 'runs', 'isolation'];

function viewFromHash(): View | null {
  const raw = location.hash.replace(/^#/, '');
  return VIEWS.includes(raw as View) ? (raw as View) : null;
}

window.addEventListener('hashchange', () => {
  const view = viewFromHash();
  if (!view || view === state.view) return;
  state.view = view;
  state.selectedLeadId = null;
  state.attack = null;
  render();
  document.getElementById('content')?.scrollIntoView({ block: 'start' });
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadIsolation(): Promise<IsolationRow[]> {
  const countFor = async (userId: string): Promise<Map<string, number>> => {
    const rows = await asTenant(userId, (q) => q.query<{ table_name: string; n: string }>(ISOLATION_SQL));
    return new Map(rows.rows.map((row) => [row.table_name, Number(row.n)]));
  };

  // Sequential on purpose: one connection, one identity at a time.
  const acme = await countFor(ACME);
  const globex = await countFor(GLOBEX);
  return TABLES.map((table) => ({
    table,
    acme: acme.get(table) ?? 0,
    globex: globex.get(table) ?? 0,
  }));
}

async function refresh(): Promise<void> {
  const data = await asTenant(ACME, async (q) => ({
    analytics: await getAnalytics(q, ACME),
    queue: await listApprovalQueue(q, ACME, 50),
    drafts: await listRecentDrafts(q, ACME, 40),
    leads: await listScoredLeads(q, ACME, 200),
    runs: await listRuns(q, ACME, 20),
    chain: await verifyApprovalChain({ db: q }, ACME),
  }));

  state.analytics = data.analytics;
  state.queue = data.queue;
  state.drafts = data.drafts;
  state.leads = data.leads;
  state.runs = data.runs;
  state.chain = data.chain;

  if (!state.selectedRunId || !data.runs.some((run) => run.id === state.selectedRunId)) {
    state.selectedRunId = data.runs[0]?.id ?? null;
  }
  state.steps = state.selectedRunId
    ? await asTenant(ACME, (q) => getRunSteps(q, ACME, state.selectedRunId as string))
    : [];

  if (state.selectedDraftId && !data.queue.some((item) => item.draftId === state.selectedDraftId)) {
    state.selectedDraftId = data.queue[0]?.draftId ?? null;
  }
  if (!state.selectedDraftId) {
    state.selectedDraftId = data.queue[0]?.draftId ?? null;
  }

  state.isolation = await loadIsolation();
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function runPlay(): Promise<void> {
  if (state.busy) return;
  state.busy = 'run';
  render();

  try {
    const summary = await asTenant(ACME, (q) =>
      runSalesWorkflow({ db: q, now: () => new Date(), sleep }, {
        userId: ACME,
        goal: GOAL,
        limit: 8,
      }),
    );
    state.lastRun = summary;
    toast(
      'ok',
      summary.draftsMade > 0
        ? `${summary.draftsMade} drafts from ${summary.leadsSeen} leads, waiting for approval.`
        : `${summary.leadsSeen} leads examined, 0 new drafts: every content hash already exists.`,
    );
    await refresh();
  } catch (error) {
    toast('bad', error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = null;
    render();
  }
}

async function decide(draftId: string, decision: 'approved' | 'rejected'): Promise<void> {
  if (state.busy) return;
  const note = (document.getElementById('decision-note') as HTMLTextAreaElement | null)?.value ?? '';
  state.busy = 'decide';
  render();

  try {
    const result = await asTenant(ACME, (q) =>
      decideApproval({ db: q, now: () => new Date() }, {
        userId: ACME,
        draftId,
        decision,
        actor: ACTOR,
        note: note.trim() || undefined,
      }),
    );
    toast(
      'ok',
      result.alreadyRecorded
        ? `Already recorded as ${result.decision} at entry #${result.seq}.`
        : `${decision === 'approved' ? 'Approved' : 'Rejected'} as audit entry #${result.seq}.`,
    );
    await refresh();
  } catch (error) {
    toast('bad', error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = null;
    render();
  }
}

async function send(draftId: string): Promise<void> {
  if (state.busy) return;
  state.busy = 'send';
  render();

  try {
    const result = await asTenant(ACME, (q) =>
      sendDraft({ db: q, provider: dryRunProvider, now: () => new Date() }, {
        userId: ACME,
        draftId,
        actor: ACTOR,
      }),
    );
    toast(
      'ok',
      result.alreadySent
        ? `Already sent. Receipt ${result.messageId}.`
        : `Sent through ${dryRunProvider.id} in ${result.attempts} attempt(s). Receipt ${result.messageId}.`,
    );
    await refresh();
  } catch (error) {
    toast('bad', error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = null;
    render();
  }
}

async function runAttack(kind: 'write' | 'anon'): Promise<void> {
  if (state.busy) return;
  state.busy = 'attack';
  render();

  const writeSql = `insert into leads (user_id, company, domain, contact_name, contact_role, contact_email, source)
values ('${ACME}', 'Forged Co', 'forged.example', 'Attacker', 'CEO', 'a@forged.example', 'inbound')`;
  const anonSql = 'select count(*) from leads';

  try {
    if (kind === 'write') {
      await asTenant(GLOBEX, (q) =>
        q.query(
          `insert into leads (user_id, company, domain, contact_name, contact_role, contact_email, source)
           values ($1, 'Forged Co', 'forged.example', 'Attacker', 'CEO', 'a@forged.example', 'inbound')`,
          [ACME],
        ),
      );
      state.attack = { label: 'Globex inserting a lead owned by Acme', sql: writeSql, error: 'no error: the row was accepted' };
      toast('bad', 'The write was not blocked.');
    } else {
      await asAnon((q) => q.query(anonSql));
      state.attack = { label: 'anon reading leads', sql: anonSql, error: 'no error: the read was accepted' };
      toast('bad', 'anon was allowed to read.');
    }
  } catch (error) {
    state.attack = {
      label: kind === 'write' ? 'Globex inserting a lead owned by Acme' : 'anon reading leads',
      sql: kind === 'write' ? writeSql : anonSql,
      error: error instanceof Error ? error.message : String(error),
    };
    toast('ok', 'Blocked by the database.');
  } finally {
    state.busy = null;
    render();
  }
}

async function reverifyChain(): Promise<void> {
  try {
    state.chain = await asTenant(ACME, (q) => verifyApprovalChain({ db: q }, ACME));
    toast(state.chain.ok ? 'ok' : 'bad', state.chain.ok ? `${state.chain.checked} entries verified.` : `Chain broken at ${state.chain.brokenAt}.`);
    render();
  } catch (error) {
    toast('bad', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const id = target.dataset.id ?? '';

  switch (action) {
    case 'nav':
      go((target.dataset.view as View) ?? 'overview');
      break;
    case 'run-play':
      void runPlay();
      break;
    case 'select-lead':
      state.selectedLeadId = id;
      render();
      break;
    case 'close-drawer':
      state.selectedLeadId = null;
      render();
      break;
    case 'select-draft':
      state.selectedDraftId = id;
      render();
      break;
    case 'approve':
      void decide(id, 'approved');
      break;
    case 'reject':
      void decide(id, 'rejected');
      break;
    case 'send':
      void send(id);
      break;
    case 'select-run':
      state.selectedRunId = id;
      void asTenant(ACME, (q) => getRunSteps(q, ACME, id)).then((steps) => {
        state.steps = steps;
        render();
      });
      break;
    case 'attack':
      void runAttack((target.dataset.kind as 'write' | 'anon') ?? 'write');
      break;
    case 'verify-chain':
      void reverifyChain();
      break;
    case 'dismiss-toast':
      state.toast = null;
      render();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selectedLeadId) {
    state.selectedLeadId = null;
    render();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  state.view = viewFromHash() ?? 'overview';
  render();

  try {
    db = await PGlite.create();
    state.bootStep = 1;
    render();

    await db.exec(SCHEMA_SQL);
    await db.exec(ROLES_SQL);
    await db.exec(POLICIES_SQL);
    await db.exec(OPS_SQL);
    state.bootStep = 2;
    render();

    await db.exec(SEED_SQL);
    await db.exec(OPS_SEED_SQL);
    state.bootStep = 3;
    render();

    const summary = await asTenant(ACME, (q) =>
      runSalesWorkflow({ db: q, now: () => new Date(), sleep }, {
        userId: ACME,
        goal: GOAL,
        limit: 8,
      }),
    );
    state.lastRun = summary;
    state.bootStep = 4;

    state.stage = 'ready';
    await refresh();
  } catch (error) {
    state.stage = 'error';
    state.bootError = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    render();
  }
}

void boot();
