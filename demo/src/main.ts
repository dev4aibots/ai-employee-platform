import { PGlite } from '@electric-sql/pglite';
import { POLICIES_SQL, ROLES_SQL, SCHEMA_SQL, SEED_SQL } from './generated/sql';
import './style.css';

// ---------------------------------------------------------------------------
// Tenant ids come from db/seed.sql. Nothing here is generated at runtime.
// ---------------------------------------------------------------------------
const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';
const ACME_EMPLOYEE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GLOBEX_EMPLOYEE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const GLOBEX_DOC = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';

let db: PGlite;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Postgres session helpers — the same shape as src/db/harness.ts
// ---------------------------------------------------------------------------
async function resetIdentity(): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.query(`select set_config('app.privileged', 'off', false)`);
}

async function asTenant<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await resetIdentity();
  }
}

async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('set role anon');
  try {
    return await fn();
  } finally {
    await resetIdentity();
  }
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------
type Expectation = 'allowed' | 'blocked';

interface Outcome {
  rows: unknown[];
  error?: string;
}

interface Scenario {
  id: string;
  title: string;
  why: string;
  sql: string;
  expect: Expectation;
  run: () => Promise<Outcome>;
}

async function attempt(fn: () => Promise<{ rows: unknown[] }>): Promise<Outcome> {
  try {
    const result = await fn();
    return { rows: result.rows };
  } catch (error) {
    return { rows: [], error: (error as Error).message.split('\n')[0] ?? 'unknown error' };
  }
}

const SCENARIOS: Scenario[] = [
  {
    id: 'acme-reads',
    title: 'Acme reads its own documents',
    why: 'The baseline. A tenant must be able to see its own data, otherwise every refusal below could be a broken query rather than a working policy.',
    sql: 'select title from documents',
    expect: 'allowed',
    run: () =>
      attempt(() =>
        asTenant(ACME, () => db.query<{ title: string }>('select title from documents order by title')),
      ),
  },
  {
    id: 'globex-reads',
    title: 'Globex reads its own documents',
    why: 'The same query, a different session, a different answer. Row level security is per row, not per deployment.',
    sql: 'select title from documents',
    expect: 'allowed',
    run: () =>
      attempt(() =>
        asTenant(GLOBEX, () => db.query<{ title: string }>('select title from documents order by title')),
      ),
  },
  {
    id: 'acme-steals-doc',
    title: 'Acme asks for a Globex document by primary key',
    why: 'Knowing the UUID of another tenant row must not be enough. This returns zero rows rather than an error, so an attacker learns nothing from the difference.',
    sql: `select * from documents where id = '${GLOBEX_DOC}'`,
    expect: 'blocked',
    run: () =>
      attempt(() => asTenant(ACME, () => db.query('select * from documents where id = $1', [GLOBEX_DOC]))),
  },
  {
    id: 'acme-steals-profile',
    title: 'Acme asks for the Globex billing profile',
    why: 'Plan, seats and trial dates are commercially sensitive. Same rule, different table.',
    sql: `select email, plan from profiles where id = '${GLOBEX}'`,
    expect: 'blocked',
    run: () =>
      attempt(() =>
        asTenant(ACME, () => db.query('select email, plan from profiles where id = $1', [GLOBEX])),
      ),
  },
  {
    id: 'acme-steals-employee',
    title: 'Acme asks for a Globex deployed employee',
    why: 'The agent inventory reveals what a competitor has automated.',
    sql: `select * from employees where id = '${GLOBEX_EMPLOYEE}'`,
    expect: 'blocked',
    run: () =>
      attempt(() => asTenant(ACME, () => db.query('select * from employees where id = $1', [GLOBEX_EMPLOYEE]))),
  },
  {
    id: 'anon-reads',
    title: 'An unauthenticated visitor reads documents',
    why: 'The public role holds no table grants at all, so this fails at the privilege layer before row level security is consulted. Two independent controls, not one.',
    sql: 'select title from documents   -- as role anon',
    expect: 'blocked',
    run: () => attempt(() => asAnon(() => db.query('select title from documents'))),
  },
  {
    id: 'acme-forges-doc',
    title: 'Acme inserts a document owned by Globex',
    why: 'A read filter is useless if writes are unchecked. The WITH CHECK clause rejects the row outright.',
    sql: `insert into documents (user_id, title, content) values ('${GLOBEX}', 'forged', 'forged')`,
    expect: 'blocked',
    run: () =>
      attempt(() =>
        asTenant(ACME, () =>
          db.query(`insert into documents (user_id, title, content) values ($1, 'forged', 'forged')`, [GLOBEX]),
        ),
      ),
  },
  {
    id: 'acme-cross-references',
    title: 'Acme attaches a message to a Globex employee',
    why: 'The subtle one. Checking only whether user_id matches would allow this, because the row is owned by Acme while pointing at a Globex employee. The policy also verifies employee ownership.',
    sql: `insert into messages (user_id, employee_id, role, content)
values ('${ACME}', '${GLOBEX_EMPLOYEE}', 'user', 'cross tenant')`,
    expect: 'blocked',
    run: () =>
      attempt(() =>
        asTenant(ACME, () =>
          db.query(
            `insert into messages (user_id, employee_id, role, content) values ($1, $2, 'user', 'cross tenant reference')`,
            [ACME, GLOBEX_EMPLOYEE],
          ),
        ),
      ),
  },
  {
    id: 'acme-legit-message',
    title: 'Acme attaches a message to its own employee',
    why: 'The same insert with a legitimate reference must succeed. A control that blocks everything is not a control.',
    sql: `insert into messages (user_id, employee_id, role, content)
values ('${ACME}', '${ACME_EMPLOYEE}', 'user', 'legitimate')`,
    expect: 'allowed',
    run: () =>
      attempt(() =>
        asTenant(ACME, () =>
          db.query(
            `insert into messages (user_id, employee_id, role, content) values ($1, $2, 'user', 'legitimate message') returning id`,
            [ACME, ACME_EMPLOYEE],
          ),
        ),
      ),
  },
  {
    id: 'acme-escalates',
    title: 'Acme upgrades itself to the Scale plan',
    why: 'Policies decide rows; they do not decide columns. A tenant may edit its own profile, so a trigger compares old and new values and refuses anything billing-owned.',
    sql: `update profiles set plan = 'scale', seats = 500 where id = '${ACME}'`,
    expect: 'blocked',
    run: () =>
      attempt(() =>
        asTenant(ACME, () => db.query(`update profiles set plan = 'scale', seats = 500 where id = $1`, [ACME])),
      ),
  },
  {
    id: 'acme-deletes',
    title: 'Acme deletes a Globex document',
    why: 'Destructive cross-tenant access is still cross-tenant access. The row is verified intact from a privileged session afterwards, so a silent no-op cannot hide a real deletion.',
    sql: `delete from documents where id = '${GLOBEX_DOC}'`,
    expect: 'blocked',
    run: async () => {
      const outcome = await attempt(() =>
        asTenant(ACME, () => db.query('delete from documents where id = $1', [GLOBEX_DOC])),
      );

      await db.query(`select set_config('app.privileged', 'on', false)`);
      await db.exec('set role service_role');
      const still = await db.query<{ n: number }>('select count(*)::int as n from documents where id = $1', [
        GLOBEX_DOC,
      ]);
      await resetIdentity();

      const survived = Number(still.rows[0]?.n ?? 0) === 1;
      return survived ? outcome : { rows: [{ note: 'ROW WAS DELETED' }] };
    },
  },
  {
    id: 'acme-self-edit',
    title: 'Acme edits a harmless profile field',
    why: 'The company name is legitimately the tenant own. The guard must allow it, or the product is unusable and someone will disable the guard.',
    sql: `update profiles set company_name = 'Acme Robotics Pvt Ltd' where id = '${ACME}'`,
    expect: 'allowed',
    run: () =>
      attempt(() =>
        asTenant(ACME, () =>
          db.query(
            `update profiles set company_name = 'Acme Robotics Pvt Ltd' where id = $1 returning company_name`,
            [ACME],
          ),
        ),
      ),
  },
];

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
type Verdict = 'pass' | 'fail';

function judge(scenario: Scenario, outcome: Outcome): Verdict {
  const refused = Boolean(outcome.error) || outcome.rows.length === 0;
  if (scenario.expect === 'blocked') return refused ? 'pass' : 'fail';
  return !refused ? 'pass' : 'fail';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatRows(rows: unknown[]): string {
  if (rows.length === 0) return '(no rows)';
  return JSON.stringify(rows, null, 2);
}

function renderIndex(): void {
  $('scenario-list').innerHTML = SCENARIOS.map(
    (scenario, index) => `
      <li data-n="${String(index + 1).padStart(2, '0')}" data-state="pending" data-target="${scenario.id}">
        <button type="button" class="index-link">${escapeHtml(scenario.title)}</button>
      </li>
    `,
  ).join('');

  document.querySelectorAll<HTMLButtonElement>('.index-link').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.closest<HTMLElement>('li')!.dataset.target!;
      const card = document.querySelector<HTMLElement>(`[data-scenario="${id}"]`);
      if (!card) return;
      const toggle = card.querySelector<HTMLButtonElement>('.scenario__toggle')!;
      const body = card.querySelector<HTMLElement>('.scenario__body')!;
      toggle.setAttribute('aria-expanded', 'true');
      body.hidden = false;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

function renderCards(): void {
  $('output-body').innerHTML = SCENARIOS.map(
    (scenario, index) => `
      <article class="scenario" data-scenario="${scenario.id}" data-state="pending">
        <button class="scenario__toggle" type="button" aria-expanded="false">
          <span class="scenario__index">${String(index + 1).padStart(2, '0')}</span>
          <span class="scenario__title">${escapeHtml(scenario.title)}</span>
          <span class="scenario__verdict" aria-live="polite"></span>
          <span class="scenario__timing"></span>
        </button>
        <div class="scenario__body" hidden></div>
      </article>
    `,
  ).join('');

  document.querySelectorAll<HTMLButtonElement>('.scenario__toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest<HTMLElement>('.scenario')!;
      const body = card.querySelector<HTMLElement>('.scenario__body')!;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    });
  });
}

function syncIndex(scenarioId: string, verdict: Verdict): void {
  const item = document.querySelector<HTMLElement>(`[data-target="${scenarioId}"]`);
  if (item) item.dataset.state = verdict;
}

function renderScenarioResult(scenario: Scenario, outcome: Outcome, verdict: Verdict, ms: number): void {
  const card = document.querySelector<HTMLElement>(`[data-scenario="${scenario.id}"]`);
  if (!card) return;

  card.dataset.state = verdict;
  card.querySelector<HTMLElement>('.scenario__verdict')!.textContent = verdict === 'pass' ? 'PASS' : 'FAIL';
  card.querySelector<HTMLElement>('.scenario__timing')!.textContent = `${ms} ms`;

  const body = card.querySelector<HTMLElement>('.scenario__body')!;
  const errorBlock = outcome.error
    ? `<pre class="result result--error">${escapeHtml(outcome.error)}</pre>`
    : '';
  const rowsBlock = outcome.error
    ? ''
    : `<pre class="result">${escapeHtml(formatRows(outcome.rows))}</pre>`;

  body.innerHTML = `
    <p class="scenario__why">${escapeHtml(scenario.why)}</p>
    <p class="scenario__label">SQL</p>
    <pre class="result result--sql">${escapeHtml(scenario.sql)}</pre>
    <p class="scenario__label">Expected</p>
    <p class="scenario__expect">${scenario.expect === 'blocked' ? 'refused by the database' : 'returns rows'}</p>
    <p class="scenario__label">Actual</p>
    ${errorBlock}${rowsBlock}
  `;

  syncIndex(scenario.id, verdict);
}

function setStatus(text: string, state: 'pending' | 'ready' | 'error'): void {
  const el = $('boot-status');
  el.textContent = text;
  el.className = `status status--${state}`;
}

function setMeta(text: string): void {
  $('output-meta').textContent = text;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runScenario(scenario: Scenario): Promise<Verdict> {
  const started = performance.now();
  const outcome = await scenario.run();
  const elapsed = Math.round(performance.now() - started);
  const verdict = judge(scenario, outcome);
  renderScenarioResult(scenario, outcome, verdict, elapsed);
  return verdict;
}

async function runAll(): Promise<void> {
  const button = $<HTMLButtonElement>('run-all');
  button.disabled = true;
  button.textContent = 'Running…';

  document.querySelectorAll<HTMLButtonElement>('.scenario__toggle').forEach((toggle) => {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.closest<HTMLElement>('.scenario')!.querySelector<HTMLElement>('.scenario__body')!.hidden = true;
  });

  let passed = 0;
  for (const scenario of SCENARIOS) {
    const verdict = await runScenario(scenario);
    if (verdict === 'pass') passed += 1;
    setMeta(`${passed}/${SCENARIOS.length} passed so far`);
  }

  const all = passed === SCENARIOS.length;
  setMeta(`${passed}/${SCENARIOS.length} passed`);
  setStatus(
    all
      ? `All ${SCENARIOS.length} scenarios behaved as asserted. The database refused every cross-tenant attempt.`
      : `${SCENARIOS.length - passed} scenario(s) did not match the assertion. That is a real finding, not a display glitch.`,
    all ? 'ready' : 'error',
  );

  button.disabled = false;
  button.textContent = 'Run all scenarios again';
}

async function resetDatabase(): Promise<void> {
  const button = $<HTMLButtonElement>('reset');
  button.disabled = true;

  db = await PGlite.create();
  await db.exec(SCHEMA_SQL);
  await db.exec(ROLES_SQL);
  await db.exec(POLICIES_SQL);
  await db.exec(SEED_SQL);

  document.querySelectorAll<HTMLElement>('.scenario').forEach((card) => {
    card.dataset.state = 'pending';
    card.querySelector<HTMLElement>('.scenario__verdict')!.textContent = '';
    card.querySelector<HTMLElement>('.scenario__timing')!.textContent = '';
    const body = card.querySelector<HTMLElement>('.scenario__body')!;
    body.hidden = true;
    body.innerHTML = '';
  });
  document.querySelectorAll<HTMLElement>('[data-target]').forEach((item) => {
    item.dataset.state = 'pending';
  });

  setMeta('idle');
  setStatus('Fresh database. Press “Run all scenarios”.', 'ready');
  button.disabled = false;
  $<HTMLButtonElement>('run-all').textContent = 'Run all scenarios';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  renderIndex();
  renderCards();

  // Handlers are attached before the database exists; the buttons stay disabled
  // until it is ready, so there is no window where a click is silently dropped.
  $('run-all').addEventListener('click', () => {
    void runAll();
  });
  $('reset').addEventListener('click', () => {
    void resetDatabase();
  });

  try {
    setStatus('Booting PostgreSQL 18 (WebAssembly)…', 'pending');
    db = await PGlite.create();

    setStatus('Applying schema, roles, policies and seed data…', 'pending');
    await db.exec(SCHEMA_SQL);
    await db.exec(ROLES_SQL);
    await db.exec(POLICIES_SQL);
    await db.exec(SEED_SQL);

    const version = await db.query<{ version: string }>('select version()');
    const short = version.rows[0]?.version.split(' on ')[0] ?? 'PostgreSQL';

    setStatus(`Ready — ${short}. Press “Run all scenarios”.`, 'ready');
    $<HTMLButtonElement>('run-all').disabled = false;
    $<HTMLButtonElement>('reset').disabled = false;
  } catch (error) {
    setStatus(
      `Database failed to boot: ${(error as Error).message}. This page needs WebAssembly and about 4 MB of download.`,
      'error',
    );
  }
}

void boot();
