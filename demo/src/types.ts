import type { Analytics, DraftRow, QueueItem, RunRow } from '../../src/ops/analytics';
import type { ChainCheck } from '../../src/ops/pipeline';
import type { RunSummary, ScoredLead } from '../../src/ops/types';

export type View = 'overview' | 'leads' | 'approvals' | 'runs' | 'isolation';

export interface StepRow {
  seq: number;
  name: string;
  status: string;
  attempts: number;
  latency_ms: number;
  detail: unknown;
  error: string | null;
}

export interface IsolationRow {
  table: string;
  acme: number;
  globex: number;
}

export interface AttackResult {
  label: string;
  sql: string;
  error: string;
}

export interface Model {
  stage: 'boot' | 'ready' | 'error';
  bootStep: number;
  bootError: string | null;

  view: View;
  busy: string | null;
  toast: { kind: 'ok' | 'bad'; text: string } | null;

  analytics: Analytics | null;
  queue: QueueItem[];
  drafts: DraftRow[];
  leads: ScoredLead[];
  runs: RunRow[];
  steps: StepRow[];
  chain: ChainCheck | null;
  isolation: IsolationRow[];
  attack: AttackResult | null;

  selectedLeadId: string | null;
  selectedDraftId: string | null;
  selectedRunId: string | null;
  lastRun: RunSummary | null;
}

export type { Analytics, DraftRow, QueueItem, RunRow, ChainCheck, RunSummary, ScoredLead };
