import type { Queryable } from '../db/harness.js';
import { scoreLead } from './scoring.js';
import type { Lead, ScoredLead, Signal } from './types.js';

/**
 * Read models for the operator console.
 *
 * Every number here is a query over rows the pipeline wrote. Nothing is cached,
 * nothing is estimated: if the dashboard says 31 drafts were approved, that is
 * `count(*)` on the approvals table.
 */

export interface Analytics {
  leads: { total: number; qualified: number; contacted: number; replied: number; meeting: number; won: number; lost: number };
  drafts: { pending: number; approved: number; rejected: number; sent: number; failed: number };
  runs: { total: number; completed: number; failed: number; successRate: number };
  approval: { decisions: number; approved: number; rejected: number; interventionRate: number };
  cost: { totalUsd: number; perSentLeadUsd: number; tokens: number };
  sources: { source: string; leads: number; replies: number; replyRate: number }[];
  scores: { average: number; hot: number; warm: number; cool: number; cold: number };
  draftRate: number;
  sendRate: number;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getAnalytics(db: Queryable, userId: string): Promise<Analytics> {
  const pipeline = await db.query<{
    total: string; qualified: string; contacted: string; replied: string; meeting: string; won: string; lost: string;
  }>(
    `select count(*)::text as total,
            count(*) filter (where stage = 'qualified')::text as qualified,
            count(*) filter (where stage = 'contacted')::text as contacted,
            count(*) filter (where stage = 'replied')::text as replied,
            count(*) filter (where stage = 'meeting')::text as meeting,
            count(*) filter (where stage = 'won')::text as won,
            count(*) filter (where stage in ('lost', 'disqualified'))::text as lost
       from leads where user_id = $1`,
    [userId],
  );

  const drafts = await db.query<{
    pending: string; approved: string; rejected: string; sent: string; failed: string;
  }>(
    `select count(*) filter (where status = 'pending')::text as pending,
            count(*) filter (where status = 'approved')::text as approved,
            count(*) filter (where status = 'rejected')::text as rejected,
            count(*) filter (where status = 'sent')::text as sent,
            count(*) filter (where status = 'failed')::text as failed
       from drafts where user_id = $1`,
    [userId],
  );

  const runs = await db.query<{ total: string; completed: string; failed: string; tokens: string; cost: string }>(
    `select count(*)::text as total,
            count(*) filter (where status in ('completed', 'awaiting_approval'))::text as completed,
            count(*) filter (where status = 'failed')::text as failed,
            coalesce(sum(tokens), 0)::text as tokens,
            coalesce(sum(cost_usd), 0)::text as cost
       from ops_runs where user_id = $1`,
    [userId],
  );

  const approvals = await db.query<{ decisions: string; approved: string; rejected: string }>(
    `select count(*)::text as decisions,
            count(*) filter (where decision = 'approved')::text as approved,
            count(*) filter (where decision = 'rejected')::text as rejected
       from approvals where user_id = $1`,
    [userId],
  );

  const sources = await db.query<{ source: string; leads: string; replies: string }>(
    `select source, count(*)::text as leads,
            count(*) filter (where replied_at is not null)::text as replies
       from leads where user_id = $1
      group by source order by count(*) desc`,
    [userId],
  );

  const scored = await listScoredLeads(db, userId, 500);

  const leadRow = pipeline.rows[0];
  const draftRow = drafts.rows[0];
  const runRow = runs.rows[0];
  const approvalRow = approvals.rows[0];

  const totalLeads = num(leadRow?.total);
  const totalDrafts = num(draftRow?.pending) + num(draftRow?.approved) + num(draftRow?.rejected) + num(draftRow?.sent) + num(draftRow?.failed);
  const sent = num(draftRow?.sent);
  const decisions = num(approvalRow?.decisions);
  const runTotal = num(runRow?.total);
  const cost = num(runRow?.cost);

  return {
    leads: {
      total: totalLeads,
      qualified: num(leadRow?.qualified),
      contacted: num(leadRow?.contacted),
      replied: num(leadRow?.replied),
      meeting: num(leadRow?.meeting),
      won: num(leadRow?.won),
      lost: num(leadRow?.lost),
    },
    drafts: {
      pending: num(draftRow?.pending),
      approved: num(draftRow?.approved),
      rejected: num(draftRow?.rejected),
      sent: num(draftRow?.sent),
      failed: num(draftRow?.failed),
    },
    runs: {
      total: runTotal,
      completed: num(runRow?.completed),
      failed: num(runRow?.failed),
      successRate: runTotal === 0 ? 0 : num(runRow?.completed) / runTotal,
    },
    approval: {
      decisions,
      approved: num(approvalRow?.approved),
      rejected: num(approvalRow?.rejected),
      interventionRate: totalDrafts === 0 ? 0 : decisions / totalDrafts,
    },
    cost: {
      totalUsd: cost,
      perSentLeadUsd: sent === 0 ? 0 : cost / sent,
      tokens: num(runRow?.tokens),
    },
    sources: sources.rows.map((row) => {
      const leads = num(row.leads);
      const replies = num(row.replies);
      return { source: row.source, leads, replies, replyRate: leads === 0 ? 0 : replies / leads };
    }),
    scores: {
      average: scored.length === 0 ? 0 : scored.reduce((sum, item) => sum + item.score, 0) / scored.length,
      hot: scored.filter((item) => item.band === 'hot').length,
      warm: scored.filter((item) => item.band === 'warm').length,
      cool: scored.filter((item) => item.band === 'cool').length,
      cold: scored.filter((item) => item.band === 'cold').length,
    },
    draftRate: totalLeads === 0 ? 0 : totalDrafts / totalLeads,
    sendRate: totalDrafts === 0 ? 0 : sent / totalDrafts,
  };
}

export async function listScoredLeads(db: Queryable, userId: string, limit = 200): Promise<ScoredLead[]> {
  const leads = await db.query<Lead>(
    `select id, company, domain, contact_name, contact_role, contact_email, source, stage,
            employees, funding_stage, hq_city,
            last_contact_at::text as last_contact_at,
            replied_at::text as replied_at
       from leads where user_id = $1
      order by created_at desc
      limit $2`,
    [userId, limit],
  );

  if (leads.rows.length === 0) return [];

  const signals = await db.query<Signal>(
    `select lead_id, kind, value, weight::float8 as weight
       from lead_signals
      where user_id = $1 and lead_id = any($2::uuid[])`,
    [userId, leads.rows.map((lead) => lead.id)],
  );

  const byLead = new Map<string, Signal[]>();
  for (const signal of signals.rows) {
    const list = byLead.get(signal.lead_id);
    if (list) list.push(signal);
    else byLead.set(signal.lead_id, [signal]);
  }

  return leads.rows
    .map((lead) => scoreLead(lead, byLead.get(lead.id) ?? []))
    .sort((a, b) => b.score - a.score);
}

export interface QueueItem {
  draftId: string;
  subject: string;
  body: string;
  createdAt: string;
  writer: string;
  lead: Lead;
  score: number;
  band: ScoredLead['band'];
  contributions: ScoredLead['contributions'];
  signals: Signal[];
}

export async function listApprovalQueue(db: Queryable, userId: string, limit = 50): Promise<QueueItem[]> {
  const drafts = await db.query<{
    draft_id: string; subject: string; body: string; created_at: string; writer: string;
    id: string; company: string; domain: string; contact_name: string; contact_role: string;
    contact_email: string; source: string; stage: Lead['stage']; employees: number | null;
    funding_stage: string | null; hq_city: string | null; last_contact_at: string | null; replied_at: string | null;
  }>(
    `select d.id as draft_id, d.subject, d.body, d.created_at::text as created_at, d.writer,
            l.id, l.company, l.domain, l.contact_name, l.contact_role, l.contact_email, l.source, l.stage,
            l.employees, l.funding_stage, l.hq_city,
            l.last_contact_at::text as last_contact_at, l.replied_at::text as replied_at
       from drafts d
       join leads l on l.id = d.lead_id
      where d.user_id = $1 and d.status = 'pending'
      order by d.created_at desc
      limit $2`,
    [userId, limit],
  );

  if (drafts.rows.length === 0) return [];

  const signals = await db.query<Signal>(
    `select lead_id, kind, value, weight::float8 as weight
       from lead_signals
      where user_id = $1 and lead_id = any($2::uuid[])`,
    [userId, drafts.rows.map((row) => row.id)],
  );
  const byLead = new Map<string, Signal[]>();
  for (const signal of signals.rows) {
    const list = byLead.get(signal.lead_id);
    if (list) list.push(signal);
    else byLead.set(signal.lead_id, [signal]);
  }

  return drafts.rows.map((row) => {
    const lead: Lead = {
      id: row.id,
      company: row.company,
      domain: row.domain,
      contact_name: row.contact_name,
      contact_role: row.contact_role,
      contact_email: row.contact_email,
      source: row.source,
      stage: row.stage,
      employees: row.employees,
      funding_stage: row.funding_stage,
      hq_city: row.hq_city,
      last_contact_at: row.last_contact_at,
      replied_at: row.replied_at,
    };
    const scored = scoreLead(lead, byLead.get(lead.id) ?? []);
    return {
      draftId: row.draft_id,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
      writer: row.writer,
      lead,
      score: scored.score,
      band: scored.band,
      contributions: scored.contributions,
      signals: scored.signals,
    };
  });
}

export interface RunRow {
  id: string;
  goal: string;
  status: string;
  leadsSeen: number;
  draftsMade: number;
  tokens: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

export async function listRuns(db: Queryable, userId: string, limit = 20): Promise<RunRow[]> {
  const rows = await db.query<{
    id: string; goal: string; status: string; leads_seen: number; drafts_made: number;
    tokens: number; cost_usd: string; started_at: string; finished_at: string | null;
  }>(
    `select id, goal, status, leads_seen, drafts_made, tokens, cost_usd::text as cost_usd,
            started_at::text as started_at, finished_at::text as finished_at
       from ops_runs where user_id = $1
      order by started_at desc limit $2`,
    [userId, limit],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    status: row.status,
    leadsSeen: num(row.leads_seen),
    draftsMade: num(row.drafts_made),
    tokens: num(row.tokens),
    costUsd: num(row.cost_usd),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

export async function getRunSteps(db: Queryable, userId: string, runId: string) {
  const rows = await db.query<{
    seq: number; name: string; status: string; attempts: number; latency_ms: number; detail: unknown; error: string | null;
  }>(
    `select seq, name, status, attempts, latency_ms, detail, error
       from ops_run_steps where user_id = $1 and run_id = $2 order by seq asc`,
    [userId, runId],
  );
  return rows.rows;
}

export interface DraftRow {
  id: string;
  subject: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';
  company: string;
  contactName: string;
  createdAt: string;
}

/** Recent drafts with the lead they belong to. Used by the approval and send lists. */
export async function listRecentDrafts(db: Queryable, userId: string, limit = 40): Promise<DraftRow[]> {
  const rows = await db.query<{
    id: string; subject: string; status: DraftRow['status']; company: string; contact_name: string; created_at: string;
  }>(
    `select d.id, d.subject, d.status, l.company, l.contact_name, d.created_at::text as created_at
       from drafts d
       join leads l on l.id = d.lead_id
      where d.user_id = $1
      order by d.created_at desc, d.content_hash asc
      limit $2`,
    [userId, limit],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    status: row.status,
    company: row.company,
    contactName: row.contact_name,
    createdAt: row.created_at,
  }));
}
