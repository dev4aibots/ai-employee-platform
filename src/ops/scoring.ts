import type { Contribution, Lead, ScoredLead, Signal, SignalKind } from './types.js';

/**
 * Lead scoring.
 *
 * A score a salesperson cannot interrogate is a score they will ignore, so the
 * output is not just a number: every point is attributed to a named
 * contribution with a human-readable reason. The rule set is intentionally
 * small and deterministic - the same lead always scores the same way - which is
 * also what makes it testable.
 *
 * Weights live on the signal row, not in this file, so the model can be
 * re-tuned per tenant without a deploy.
 */

const KIND_LABEL: Record<SignalKind, string> = {
  hiring: 'Hiring',
  funding: 'Funding',
  tech: 'Tech stack',
  traffic: 'Traffic',
  intent: 'Buying intent',
  friction: 'Friction',
};

/** How much a signal kind counts, relative to its stored weight. */
const KIND_MULTIPLIER: Record<SignalKind, number> = {
  hiring: 1.0,
  funding: 1.1,
  tech: 0.8,
  traffic: 0.6,
  intent: 1.25,
  friction: 1.0,
};

/** 20 points per unit of weight, scaled by kind. */
const SIGNAL_POINTS = 20;

const BASE_POINTS = 40;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * Contact recency is not "more recent is better". A lead touched yesterday is
 * the worst possible person to email again; a lead touched three weeks ago is
 * the best. This curve encodes that.
 */
function recencyContribution(lead: Lead, now: Date): Contribution {
  const days = daysSince(lead.last_contact_at, now);
  if (days === null) {
    return { label: 'Never contacted', points: 10, reason: 'No outreach on record, so no fatigue' };
  }
  if (days < 7) {
    return { label: 'Contacted too soon', points: -12, reason: `Last touch ${days}d ago; a follow-up now reads as pressure` };
  }
  if (days <= 30) {
    return { label: 'Follow-up window', points: 8, reason: `Last touch ${days}d ago, inside the useful follow-up window` };
  }
  return { label: 'Dormant', points: 4, reason: `Last touch ${days}d ago; needs a fresh angle, not a nudge` };
}

function fitContribution(lead: Lead): Contribution {
  const size = lead.employees;
  if (size === null) {
    return { label: 'Unknown size', points: 0, reason: 'No employee count on record' };
  }
  if (size >= 50 && size <= 800) {
    return { label: 'Ideal size', points: 10, reason: `${size} employees: enough HR volume to need automation` };
  }
  if (size > 800 && size <= 3000) {
    return { label: 'Enterprise size', points: 4, reason: `${size} employees: longer cycle, procurement involved` };
  }
  if (size < 50) {
    return { label: 'Below ideal size', points: -2, reason: `${size} employees: may not feel the pain yet` };
  }
  return { label: 'Above ideal size', points: -4, reason: `${size} employees: likely already has a vendor` };
}

function stageContribution(lead: Lead): Contribution {
  switch (lead.stage) {
    case 'new':
      return { label: 'Never worked', points: 6, reason: 'Untouched inbound or sourced lead' };
    case 'qualified':
      return { label: 'Qualified', points: 4, reason: 'Already fits the profile' };
    case 'contacted':
      return { label: 'In sequence', points: 0, reason: 'Already in outreach' };
    case 'replied':
      return { label: 'Replied', points: -10, reason: 'They replied; this play is for silence, not replies' };
    case 'meeting':
    case 'won':
      return { label: 'Later stage', points: -20, reason: `Stage is ${lead.stage}; a cold follow-up would be wrong` };
    case 'lost':
    case 'disqualified':
      return { label: 'Closed out', points: -30, reason: `Stage is ${lead.stage}` };
  }
}

function signalContributions(signals: Signal[]): Contribution[] {
  return signals.map((signal) => {
    const points = signal.weight * KIND_MULTIPLIER[signal.kind] * SIGNAL_POINTS;
    return {
      label: KIND_LABEL[signal.kind],
      points: Math.round(points * 10) / 10,
      reason: signal.value,
    };
  });
}

export function bandFor(score: number): ScoredLead['band'] {
  if (score >= 75) return 'hot';
  if (score >= 55) return 'warm';
  if (score >= 35) return 'cool';
  return 'cold';
}

export function scoreLead(lead: Lead, signals: Signal[], now: Date = new Date()): ScoredLead {
  const contributions: Contribution[] = [
    { label: 'Baseline', points: BASE_POINTS, reason: 'Every lead starts from the same prior' },
    stageContribution(lead),
    recencyContribution(lead, now),
    fitContribution(lead),
    ...signalContributions(signals),
  ];

  const raw = contributions.reduce((sum, item) => sum + item.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    lead,
    score,
    band: bandFor(score),
    contributions: contributions
      .filter((item) => item.points !== 0)
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    signals,
  };
}

export function rankLeads(leads: Lead[], signals: Signal[], now: Date = new Date()): ScoredLead[] {
  const byLead = new Map<string, Signal[]>();
  for (const signal of signals) {
    const list = byLead.get(signal.lead_id);
    if (list) list.push(signal);
    else byLead.set(signal.lead_id, [signal]);
  }

  return leads
    .map((lead) => scoreLead(lead, byLead.get(lead.id) ?? [], now))
    .sort((a, b) => b.score - a.score || a.lead.company.localeCompare(b.lead.company));
}
