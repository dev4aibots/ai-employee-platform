import { sha256Hex, uuid } from '../util/hash.js';
import type { Queryable } from '../db/harness.js';
import { contentHash, templateWriter } from './drafting.js';
import { rankLeads } from './scoring.js';
import type { DraftWriter, Lead, RunStep, RunSummary, Signal } from './types.js';

/**
 * The operations pipeline.
 *
 * Every step is recorded with its latency and attempt count, because "the agent
 * ran" is not an answer an operator can act on. The design rules:
 *
 *   - the database is the queue, not a side effect: drafts land in a table the
 *     approval UI reads, so a crashed process loses no work
 *   - every external call is retried and every write is idempotent, so a retry
 *     cannot duplicate outreach
 *   - a failure leaves a `failed` run with its steps attached, never a run that
 *     says `running` forever
 *   - nothing is sent here. This function stops at "awaiting approval".
 */

export interface EmailProvider {
  id: string;
  send(message: { to: string; subject: string; body: string }): Promise<{ messageId: string }>;
}

export const dryRunProvider: EmailProvider = {
  id: 'dry-run',
  async send(message) {
    const digest = sha256Hex(`${message.to}\n${message.subject}`).slice(0, 12);
    return { messageId: `dry-run-${digest}` };
  },
};

export interface OpsDeps {
  db: Queryable;
  writer?: DraftWriter;
  provider?: EmailProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

interface StepContext {
  steps: RunStep[];
}

/** Retry with linear backoff. Records whether the call needed more than one try. */
async function withRetry<T>(
  deps: OpsDeps,
  context: StepContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const attemptsAllowed = deps.retries ?? 3;
  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    try {
      const value = await fn();
      context.steps.push({
        name,
        status: attempt === 1 ? 'ok' : 'retried',
        attempts: attempt,
        latencyMs: Date.now() - started,
        detail: {},
      });
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < attemptsAllowed) {
        await (deps.sleep ?? (async () => undefined))(attempt * 20);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  context.steps.push({
    name,
    status: 'failed',
    attempts: attemptsAllowed,
    latencyMs: Date.now() - started,
    detail: {},
    error: message,
  });
  throw lastError instanceof Error ? lastError : new Error(message);
}

async function persistSteps(deps: OpsDeps, userId: string, runId: string, steps: RunStep[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    await deps.db.query(
      `insert into ops_run_steps (user_id, run_id, seq, name, status, attempts, latency_ms, detail, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (run_id, seq) do nothing`,
      [
        userId,
        runId,
        index,
        step.name,
        step.status,
        step.attempts,
        step.latencyMs,
        JSON.stringify(step.detail),
        step.error ?? null,
      ],
    );
  }
}

export interface RunOptions {
  userId: string;
  goal: string;
  limit?: number;
  staleDays?: number;
  minScore?: number;
}

/**
 * "Find leads that have gone quiet, rank them, draft the outreach."
 * The default window is 7 days, which is the number in the job description this
 * project was built against.
 */
export async function runSalesWorkflow(deps: OpsDeps, options: RunOptions): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date();
  const limit = options.limit ?? 8;
  const staleDays = options.staleDays ?? 7;
  const minScore = options.minScore ?? 0;
  const writer = deps.writer ?? templateWriter;
  const context: StepContext = { steps: [] };
  const runId = uuid();
  const cutoff = new Date(now.getTime() - staleDays * 86_400_000).toISOString();

  await deps.db.query(
    `insert into ops_runs (id, user_id, goal, status, started_at) values ($1, $2, $3, 'running', $4)`,
    [runId, options.userId, options.goal, now.toISOString()],
  );

  try {
    const leads = await withRetry(deps, context, 'load_leads', async () => {
      const result = await deps.db.query<Lead>(
        `select id, company, domain, contact_name, contact_role, contact_email, source, stage,
                employees, funding_stage, hq_city,
                last_contact_at::text as last_contact_at,
                replied_at::text as replied_at
           from leads
          where user_id = $1
            and replied_at is null
            and stage in ('new', 'qualified', 'contacted')
            and (last_contact_at is null or last_contact_at <= $2)
          order by last_contact_at nulls first
          limit 400`,
        [options.userId, cutoff],
      );
      return result.rows;
    });

    const signals = await withRetry(deps, context, 'load_signals', async () => {
      const ids = leads.map((lead) => lead.id);
      if (ids.length === 0) return [];
      const result = await deps.db.query<Signal>(
        `select lead_id, kind, value, weight::float8 as weight
           from lead_signals
          where user_id = $1 and lead_id = any($2::uuid[])`,
        [options.userId, ids],
      );
      return result.rows;
    });

    const ranked = rankLeads(leads, signals, now).filter((item) => item.score >= minScore);
    const selected = ranked.slice(0, limit);
    context.steps.push({
      name: 'rank_leads',
      status: 'ok',
      attempts: 1,
      latencyMs: 0,
      detail: { considered: leads.length, ranked: ranked.length, selected: selected.length },
    });

    const drafts = await withRetry(deps, context, 'draft_outreach', async () => {
      const produced = [];
      for (const scored of selected) {
        const content = await writer.write({ lead: scored.lead, signals: scored.signals, score: scored });
        produced.push({ scored, content });
      }
      return produced;
    });

    const persisted = await withRetry(deps, context, 'persist_drafts', async () => {
      let made = 0;
      let skipped = 0;
      for (const { scored, content } of drafts) {
        const hash = contentHash(content.subject, content.body);
        const inserted = await deps.db.query<{ id: string }>(
          `insert into drafts (user_id, lead_id, subject, body, content_hash, writer,
                               prompt_tokens, completion_tokens, cost_usd)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (user_id, content_hash) do nothing
           returning id`,
          [
            options.userId,
            scored.lead.id,
            content.subject,
            content.body,
            hash,
            content.writer,
            content.promptTokens,
            content.completionTokens,
            content.costUsd,
          ],
        );
        if (inserted.rows.length > 0) made += 1;
        else skipped += 1;
      }
      return { made, skipped };
    });

    const tokens = drafts.reduce((sum, item) => sum + item.content.promptTokens + item.content.completionTokens, 0);
    const cost = drafts.reduce((sum, item) => sum + item.content.costUsd, 0);
    const status = persisted.made > 0 ? 'awaiting_approval' : 'completed';

    await withRetry(deps, context, 'finalize_run', async () => {
      await deps.db.query(
        `update ops_runs
            set status = $2, leads_seen = $3, drafts_made = $4, tokens = $5,
                cost_usd = $6, finished_at = $7
          where id = $1 and user_id = $8`,
        [runId, status, leads.length, persisted.made, tokens, cost, now.toISOString(), options.userId],
      );
      return null;
    });

    await persistSteps(deps, options.userId, runId, context.steps);

    return {
      runId,
      status,
      leadsSeen: leads.length,
      draftsMade: persisted.made,
      draftsSkipped: persisted.skipped,
      tokens,
      costUsd: cost,
      steps: context.steps,
      topLeads: selected,
    };
  } catch (error) {
    // A run that threw must not stay `running`. Persist the steps we have and
    // mark it failed; if that write fails too, still surface the original error.
    try {
      await persistSteps(deps, options.userId, runId, context.steps);
      await deps.db.query(
        `update ops_runs set status = 'failed', finished_at = $3 where id = $1 and user_id = $2`,
        [runId, options.userId, new Date().toISOString()],
      );
    } catch {
      // deliberately ignored: the caller needs the original failure
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type Decision = 'approved' | 'rejected';

export interface ApprovalResult {
  id: string;
  draftId: string;
  seq: number;
  decision: Decision;
  actor: string;
  decidedAt: string;
  entryHash: string;
  alreadyRecorded: boolean;
}

export function approvalHash(input: {
  prevHash: string;
  seq: number;
  contentHash: string;
  decision: Decision;
  actor: string;
  decidedAt: string;
  note: string;
}): string {
  return sha256Hex(
    [
      input.prevHash,
      String(input.seq),
      input.contentHash,
      input.decision,
      input.actor,
      input.decidedAt,
      input.note,
    ].join('\n'),
  );
}

function isUniqueViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('23505') || text.includes('duplicate key');
}

/**
 * Record a decision exactly once. Re-sending the same decision returns the
 * stored row instead of creating a second one, and a rejection can never be
 * turned into an approval by retrying with a different payload.
 */
export async function decideApproval(
  deps: OpsDeps,
  input: { userId: string; draftId: string; decision: Decision; actor: string; note?: string },
): Promise<ApprovalResult> {
  const now = deps.now?.() ?? new Date();
  const decidedAt = now.toISOString();
  const note = input.note ?? '';

  const draft = await deps.db.query<{ id: string; content_hash: string; status: string }>(
    `select id, content_hash, status from drafts where id = $1 and user_id = $2`,
    [input.draftId, input.userId],
  );
  const row = draft.rows[0];
  if (!row) throw new Error(`draft ${input.draftId} not found for this tenant`);

  const existing = await deps.db.query<ApprovalResult>(
    `select id, draft_id as "draftId", seq, decision, actor,
            to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "decidedAt",
            entry_hash as "entryHash"
       from approvals where draft_id = $1 and user_id = $2`,
    [input.draftId, input.userId],
  );
  const already = existing.rows[0];
  if (already) {
    return { ...already, seq: Number(already.seq), alreadyRecorded: true };
  }

  if (row.status !== 'pending') {
    throw new Error(`draft is ${row.status}; only pending drafts can be decided`);
  }

  // Three attempts is enough to absorb a concurrent writer bumping the same
  // sequence number; the unique constraint is what makes this correct.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await deps.db.query<{ entry_hash: string; seq: number }>(
      `select entry_hash, seq from approvals where user_id = $1 order by seq desc limit 1`,
      [input.userId],
    );
    const prevHash = previous.rows[0]?.entry_hash ?? '0'.repeat(64);
    const seq = Number(previous.rows[0]?.seq ?? 0) + 1;

    const entryHash = approvalHash({
      prevHash,
      seq,
      contentHash: row.content_hash,
      decision: input.decision,
      actor: input.actor,
      decidedAt,
      note,
    });

    try {
      const inserted = await deps.db.query<{ id: string }>(
        `insert into approvals (user_id, draft_id, seq, decision, actor, note, decided_at, entry_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (draft_id) do nothing
         returning id`,
        [input.userId, input.draftId, seq, input.decision, input.actor, note || null, decidedAt, entryHash],
      );

      const id = inserted.rows[0]?.id;
      if (!id) break; // lost the draft_id race, handled below

      await deps.db.query(`update drafts set status = $2 where id = $1 and user_id = $3`, [
        input.draftId,
        input.decision === 'approved' ? 'approved' : 'rejected',
        input.userId,
      ]);

      return {
        id,
        draftId: input.draftId,
        seq,
        decision: input.decision,
        actor: input.actor,
        decidedAt,
        entryHash,
        alreadyRecorded: false,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }

  // Either the sequence retry was exhausted, or another writer recorded this
  // draft between our read and our insert. Both are resolved by reading back.
  const raced = await deps.db.query<ApprovalResult>(
    `select id, draft_id as "draftId", seq, decision, actor,
            to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "decidedAt",
            entry_hash as "entryHash"
       from approvals where draft_id = $1 and user_id = $2`,
    [input.draftId, input.userId],
  );
  const winner = raced.rows[0];
  if (winner) return { ...winner, seq: Number(winner.seq), alreadyRecorded: true };

  throw lastError instanceof Error ? lastError : new Error('approval could not be recorded');
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
}

/** Recompute the approval chain. Used by the audit screen and the tests. */
export async function verifyApprovalChain(deps: OpsDeps, userId: string): Promise<ChainCheck> {
  const rows = await deps.db.query<{
    id: string;
    draft_id: string;
    seq: number;
    decision: Decision;
    actor: string;
    note: string | null;
    decided_at: string;
    entry_hash: string;
    content_hash: string;
  }>(
    `select a.id, a.draft_id, a.seq, a.decision, a.actor, a.note,
            to_char(a.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as decided_at,
            a.entry_hash,
            d.content_hash
       from approvals a
       join drafts d on d.id = a.draft_id
      where a.user_id = $1
      order by a.seq asc`,
    [userId],
  );

  let prevHash = '0'.repeat(64);
  for (const row of rows.rows) {
    const expected = approvalHash({
      prevHash,
      seq: Number(row.seq),
      contentHash: row.content_hash,
      decision: row.decision,
      actor: row.actor,
      decidedAt: row.decided_at,
      note: row.note ?? '',
    });
    if (expected !== row.entry_hash) {
      return { ok: false, checked: rows.rows.length, brokenAt: row.id };
    }
    prevHash = row.entry_hash;
  }
  return { ok: true, checked: rows.rows.length, brokenAt: null };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  draftId: string;
  status: 'sent' | 'dry_run';
  messageId: string;
  attempts: number;
  alreadySent: boolean;
}

interface SendRow {
  status: 'sending' | 'sent' | 'dry_run' | 'failed';
  provider_message_id: string | null;
  attempts: number;
}

/**
 * Send an approved draft.
 *
 * The write-ahead claim is the important part: the `sends` row is inserted with
 * status `sending` *before* the provider is called, and `draft_id` is unique.
 * Two concurrent callers therefore cannot both reach the provider - the loser
 * sees `sending` and refuses. A caller that crashes mid-send leaves a `sending`
 * row that an operator can inspect instead of a silent double-send.
 */
export async function sendDraft(
  deps: OpsDeps,
  input: { userId: string; draftId: string; actor: string },
): Promise<SendResult> {
  const provider = deps.provider ?? dryRunProvider;
  const now = deps.now?.() ?? new Date();
  const sentAt = now.toISOString();

  const draft = await deps.db.query<{
    id: string;
    subject: string;
    body: string;
    status: string;
    email: string;
    lead_id: string;
  }>(
    `select d.id, d.subject, d.body, d.status, l.contact_email as email, d.lead_id
       from drafts d join leads l on l.id = d.lead_id
      where d.id = $1 and d.user_id = $2`,
    [input.draftId, input.userId],
  );
  const row = draft.rows[0];
  if (!row) throw new Error(`draft ${input.draftId} not found for this tenant`);
  // `sent` is allowed through so a replay returns the original receipt instead
  // of failing; the send row is the source of truth for what happened.
  if (row.status !== 'approved' && row.status !== 'failed' && row.status !== 'sent') {
    throw new Error(`draft is ${row.status}; only approved drafts can be sent`);
  }

  let attempts = 1;

  const claim = await deps.db.query<{ id: string }>(
    `insert into sends (user_id, draft_id, provider, status, attempts, created_at)
     values ($1, $2, $3, 'sending', 1, $4)
     on conflict (draft_id) do nothing
     returning id`,
    [input.userId, input.draftId, provider.id, sentAt],
  );

  if (claim.rows.length === 0) {
    const current = await deps.db.query<SendRow>(
      `select status, provider_message_id, attempts from sends where draft_id = $1`,
      [input.draftId],
    );
    const existing = current.rows[0];
    if (!existing) throw new Error(`send state for draft ${input.draftId} disappeared`);

    if (existing.status === 'sent' || existing.status === 'dry_run') {
      return {
        draftId: input.draftId,
        status: existing.status,
        messageId: existing.provider_message_id ?? '',
        attempts: Number(existing.attempts),
        alreadySent: true,
      };
    }
    if (existing.status === 'sending') {
      throw new Error(`a send for draft ${input.draftId} is already in progress`);
    }

    // A previously failed send may be retried; the guard keeps two retries from
    // both claiming it.
    const reclaimed = await deps.db.query<{ id: string }>(
      `update sends set status = 'sending', attempts = attempts + 1, provider = $2
        where draft_id = $1 and status = 'failed'
        returning id`,
      [input.draftId, provider.id],
    );
    if (reclaimed.rows.length === 0) {
      throw new Error(`a send for draft ${input.draftId} is already in progress`);
    }
    attempts = Number(existing.attempts) + 1;
    await deps.db.query(`update drafts set status = 'approved' where id = $1 and user_id = $2`, [
      input.draftId,
      input.userId,
    ]);
  }

  let messageId = '';
  let lastError: unknown;
  const allowed = deps.retries ?? 3;

  for (let attempt = 1; attempt <= allowed; attempt += 1) {
    try {
      const receipt = await provider.send({ to: row.email, subject: row.subject, body: row.body });
      messageId = receipt.messageId;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < allowed) {
        await (deps.sleep ?? (async () => undefined))(attempt * 20);
      }
    }
  }

  if (lastError) {
    await deps.db.query(`update sends set status = 'failed' where draft_id = $1 and status = 'sending'`, [
      input.draftId,
    ]);
    await deps.db.query(`update drafts set status = 'failed' where id = $1 and user_id = $2`, [
      input.draftId,
      input.userId,
    ]);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const status = provider.id === 'dry-run' ? 'dry_run' : 'sent';
  await deps.db.query(
    `update sends set status = $2, provider_message_id = $3, sent_at = $4
      where draft_id = $1 and status = 'sending'`,
    [input.draftId, status, messageId, sentAt],
  );
  await deps.db.query(`update drafts set status = 'sent' where id = $1 and user_id = $2`, [
    input.draftId,
    input.userId,
  ]);
  await deps.db.query(
    `update leads set stage = 'contacted', last_contact_at = $3
      where id = $1 and user_id = $2 and stage in ('new', 'qualified', 'contacted')`,
    [row.lead_id, input.userId, sentAt],
  );

  return { draftId: input.draftId, status, messageId, attempts, alreadySent: false };
}
