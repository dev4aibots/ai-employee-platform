/**
 * Domain types for the business-operations layer.
 *
 * These are deliberately narrow: the database is the source of truth, and the
 * functions in this folder take rows in and return rows out so the same code
 * runs in the test harness, the CLI and the browser demo.
 */

export type LeadStage =
  | 'new'
  | 'qualified'
  | 'contacted'
  | 'replied'
  | 'meeting'
  | 'won'
  | 'lost'
  | 'disqualified';

export type SignalKind = 'hiring' | 'funding' | 'tech' | 'traffic' | 'intent' | 'friction';

export interface Lead {
  id: string;
  company: string;
  domain: string;
  contact_name: string;
  contact_role: string;
  contact_email: string;
  source: string;
  stage: LeadStage;
  employees: number | null;
  funding_stage: string | null;
  hq_city: string | null;
  last_contact_at: string | null;
  replied_at: string | null;
}

export interface Signal {
  lead_id: string;
  kind: SignalKind;
  value: string;
  weight: number;
}

export interface Contribution {
  label: string;
  points: number;
  reason: string;
}

export interface ScoredLead {
  lead: Lead;
  score: number;
  band: 'hot' | 'warm' | 'cool' | 'cold';
  contributions: Contribution[];
  signals: Signal[];
}

export interface DraftContent {
  subject: string;
  body: string;
  writer: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface DraftWriter {
  id: string;
  write(input: { lead: Lead; signals: Signal[]; score: ScoredLead }): Promise<DraftContent>;
}

export interface RunStep {
  name: string;
  status: 'ok' | 'retried' | 'failed';
  attempts: number;
  latencyMs: number;
  detail: Record<string, unknown>;
  error?: string;
}

export interface RunSummary {
  runId: string;
  status: 'completed' | 'awaiting_approval' | 'failed';
  leadsSeen: number;
  draftsMade: number;
  draftsSkipped: number;
  tokens: number;
  costUsd: number;
  steps: RunStep[];
  topLeads: ScoredLead[];
}
