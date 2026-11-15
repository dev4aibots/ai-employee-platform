import { sha256Hex } from '../util/hash.js';
import type { DraftContent, DraftWriter, Lead, ScoredLead, Signal } from './types.js';

/**
 * Draft generation.
 *
 * Two things matter more than the prose:
 *
 *   1. Determinism. The same lead and signals must produce the same bytes, or
 *      "draft this lead twice" creates two different emails and the approval
 *      queue fills with near-duplicates. The content hash is the idempotency
 *      key, so determinism is a correctness property, not a style preference.
 *   2. Attribution. The draft quotes the specific signal that justified the
 *      score. A reviewer can see why this person is being emailed, which is
 *      what makes an approval gate meaningful instead of theatre.
 *
 * The template writer below is the offline writer. An LLM writer implements the
 * same interface and is selected by configuration; the rest of the pipeline
 * cannot tell the difference.
 */

export const TEMPLATE_WRITER = 'template-v1';

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function pickSignal(signals: Signal[]): Signal | null {
  const positive = signals.filter((signal) => signal.weight > 0);
  if (positive.length === 0) return null;
  return [...positive].sort((a, b) => b.weight - a.weight)[0] ?? null;
}

const OPENERS: Record<string, string> = {
  hiring: 'you are hiring for the team that would own this',
  funding: 'the new round usually lands on the operations team first',
  tech: 'your stack already exposes the data this needs',
  traffic: 'the volume you are handling is exactly where manual review breaks',
  intent: 'you have been looking at this problem already',
  friction: 'the manual work you described is the part we remove',
};

function subjectFor(lead: Lead, signal: Signal | null): string {
  const company = lead.company;
  if (!signal) return `${company}: 15 minutes on the manual HR queue?`;
  switch (signal.kind) {
    case 'hiring':
      return `${company}: hiring for HR ops, and the queue behind it`;
    case 'funding':
      return `${company}: after the round, the ops backlog`;
    case 'intent':
      return `${company}: the workflow you looked at last week`;
    case 'friction':
      return `${company}: the manual step you mentioned`;
    default:
      return `${company}: one less manual queue`;
  }
}

function bodyFor(lead: Lead, signal: Signal | null, score: ScoredLead): string {
  const name = firstName(lead.contact_name);
  const opener = signal ? OPENERS[signal.kind] ?? 'this is the part of the workflow we shorten' : 'this is the part of the workflow we shorten';
  const evidence = signal ? signal.value : 'the volume your team is handling';
  const size = lead.employees ? `${lead.employees}-person` : 'growing';
  // The ask follows the score: a strong fit gets a meeting request, a weak one
  // gets a document. Sending the same CTA to everyone is how outreach earns a
  // spam reputation.
  const ask =
    score.band === 'hot' || score.band === 'warm'
      ? 'Worth 15 minutes next week to see whether your queue looks like the ones we already run?'
      : 'If this is on your roadmap, I can send a two-page outline instead of asking for a call.';

  return [
    `Hi ${name},`,
    '',
    `I work with ${size} HR teams on the queue that never empties: the same intake, the same checks, the same follow-up, every week.`,
    '',
    `The reason I am writing to you specifically: ${evidence}.`,
    '',
    `For your team that usually means ${opener}.`,
    '',
    `We build the agent that does the first pass - reading the request, checking it against policy, drafting the reply - and leaves the decision with you. Every send has a named approver and an audit entry behind it.`,
    '',
    ask,
    '',
    `- Devraj`,
    `Dev4AIBots`,
    '',
    `Reply "not now" and I will close the file.`,
  ].join('\n');
}

export function contentHash(subject: string, body: string): string {
  return sha256Hex(`${subject}\n${body}`);
}

export function buildDraftContent(lead: Lead, signals: Signal[], score: ScoredLead): DraftContent {
  const signal = pickSignal(signals);
  const subject = subjectFor(lead, signal);
  const body = bodyFor(lead, signal, score);

  // The template writer makes no model call, so it reports zero tokens and zero
  // cost rather than inventing plausible-looking numbers.
  return {
    subject,
    body,
    writer: TEMPLATE_WRITER,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
}

/** Synchronous deterministic writer, wrapped in the async interface. */
export const templateWriter: DraftWriter = {
  id: TEMPLATE_WRITER,
  async write({ lead, signals, score }) {
    return buildDraftContent(lead, signals, score);
  },
};
