import { describe, expect, it } from 'vitest';
import { bandFor, rankLeads, scoreLead } from '../src/ops/scoring.js';
import { buildDraftContent, contentHash, templateWriter } from '../src/ops/drafting.js';
import type { Lead, Signal } from '../src/ops/types.js';

/**
 * Scoring and drafting are pure functions, so they are tested without a
 * database. The properties that matter are determinism and attribution: the
 * same lead must always score the same way, and every point must be traceable
 * to a named contribution.
 */

const NOW = new Date('2026-11-15T09:00:00.000Z');

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    company: 'Kestrel HR 1',
    domain: 'kestrel.example',
    contact_name: 'Aarav Shah',
    contact_role: 'Head of People',
    contact_email: 'aarav@kestrel.example',
    source: 'inbound',
    stage: 'new',
    employees: 120,
    funding_stage: 'seed',
    hq_city: 'Bengaluru',
    last_contact_at: null,
    replied_at: null,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    lead_id: '11111111-1111-4111-8111-111111111111',
    kind: 'hiring',
    value: 'posted three people-ops roles this week',
    weight: 0.7,
    ...overrides,
  };
}

describe('scoreLead', () => {
  it('is deterministic: same inputs produce the same score', () => {
    const a = scoreLead(lead(), [signal()], NOW);
    const b = scoreLead(lead(), [signal()], NOW);
    expect(a).toEqual(b);
  });

  it('attributes every point to a named contribution', () => {
    const scored = scoreLead(lead(), [signal()], NOW);
    const summed = scored.contributions.reduce((sum, item) => sum + item.points, 0);
    expect(Math.round(summed)).toBe(scored.score);
  });

  it('scores an untouched, well-sized lead as warm', () => {
    // 40 base + 6 new + 10 never contacted + 10 ideal size
    const scored = scoreLead(lead(), [], NOW);
    expect(scored.score).toBe(66);
    expect(scored.band).toBe('warm');
  });

  it('lets a strong buying signal move a lead into hot', () => {
    // 66 + 0.9 * 1.25 * 20 = 88.5
    const scored = scoreLead(lead(), [signal({ kind: 'intent', weight: 0.9 })], NOW);
    expect(scored.score).toBe(89);
    expect(scored.band).toBe('hot');
  });

  it('penalises a lead contacted yesterday', () => {
    const fresh = scoreLead(lead({ last_contact_at: daysAgo(1) }), [], NOW);
    const rested = scoreLead(lead({ last_contact_at: daysAgo(14) }), [], NOW);
    expect(fresh.score).toBeLessThan(rested.score);
    expect(fresh.contributions.map((c) => c.label)).toContain('Contacted too soon');
  });

  it('treats seven days as inside the follow-up window', () => {
    const scored = scoreLead(lead({ last_contact_at: daysAgo(7) }), [], NOW);
    expect(scored.contributions.map((c) => c.label)).toContain('Follow-up window');
  });

  it('penalises leads already later in the pipeline', () => {
    const replied = scoreLead(lead({ stage: 'replied' }), [], NOW);
    const won = scoreLead(lead({ stage: 'won' }), [], NOW);
    expect(replied.score).toBeLessThan(66);
    expect(won.score).toBeLessThan(replied.score);
  });

  it('clamps to 0..100', () => {
    const hot = scoreLead(
      lead(),
      Array.from({ length: 8 }, () => signal({ kind: 'intent', weight: 1 })),
      NOW,
    );
    expect(hot.score).toBe(100);

    const cold = scoreLead(
      lead({ stage: 'lost', last_contact_at: daysAgo(2) }),
      Array.from({ length: 8 }, () => signal({ kind: 'friction', weight: -1 })),
      NOW,
    );
    expect(cold.score).toBe(0);
  });

  it('drops zero-point contributions instead of padding the list', () => {
    const scored = scoreLead(lead({ employees: null }), [], NOW);
    expect(scored.contributions.every((item) => item.points !== 0)).toBe(true);
    expect(scored.contributions.map((c) => c.label)).not.toContain('Unknown size');
  });

  it('orders contributions by absolute weight', () => {
    const scored = scoreLead(lead(), [signal({ kind: 'intent', weight: 0.9 })], NOW);
    const magnitudes = scored.contributions.map((c) => Math.abs(c.points));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });
});

describe('bandFor', () => {
  it('uses the documented boundaries', () => {
    expect(bandFor(100)).toBe('hot');
    expect(bandFor(75)).toBe('hot');
    expect(bandFor(74)).toBe('warm');
    expect(bandFor(55)).toBe('warm');
    expect(bandFor(54)).toBe('cool');
    expect(bandFor(35)).toBe('cool');
    expect(bandFor(34)).toBe('cold');
    expect(bandFor(0)).toBe('cold');
  });
});

describe('rankLeads', () => {
  it('sorts by score and breaks ties by company name', () => {
    const leads = [
      lead({ id: 'a', company: 'Zenith' }),
      lead({ id: 'b', company: 'Aperture' }),
      lead({ id: 'c', company: 'Meridian', stage: 'lost' }),
    ];
    const ranked = rankLeads(leads, [], NOW);
    expect(ranked.map((r) => r.lead.company)).toEqual(['Aperture', 'Zenith', 'Meridian']);
  });

  it('attaches each signal only to its own lead', () => {
    const leads = [lead({ id: 'a', company: 'A' }), lead({ id: 'b', company: 'B' })];
    const ranked = rankLeads(leads, [signal({ lead_id: 'a', kind: 'intent', weight: 0.9 })], NOW);
    expect(ranked[0]?.lead.id).toBe('a');
    expect(ranked[1]?.signals).toHaveLength(0);
  });
});

describe('buildDraftContent', () => {
  it('quotes the highest-weight positive signal as evidence', () => {
    const scored = scoreLead(lead(), [signal({ kind: 'hiring', weight: 0.7 })], NOW);
    const draft = buildDraftContent(lead(), [signal({ kind: 'hiring', weight: 0.7 })], scored);
    expect(draft.body).toContain('posted three people-ops roles this week');
    expect(draft.body).toContain('Aarav');
  });

  it('ignores negative signals when choosing the evidence', () => {
    const scored = scoreLead(lead(), [], NOW);
    const draft = buildDraftContent(
      lead(),
      [
        signal({ kind: 'friction', value: 'a four-day support queue', weight: -0.9 }),
        signal({ kind: 'hiring', value: 'two open HR roles', weight: 0.7 }),
      ],
      scored,
    );
    expect(draft.body).toContain('two open HR roles');
    expect(draft.body).not.toContain('four-day support queue');
  });

  it('is byte-for-byte deterministic', () => {
    const scored = scoreLead(lead(), [signal()], NOW);
    const a = buildDraftContent(lead(), [signal()], scored);
    const b = buildDraftContent(lead(), [signal()], scored);
    expect(a).toEqual(b);
    expect(contentHash(a.subject, a.body)).toBe(contentHash(b.subject, b.body));
  });

  it('reports zero tokens and zero cost for the template writer', () => {
    // Inventing plausible model usage would make every cost number downstream a
    // fiction. The offline writer honestly reports nothing.
    const draft = buildDraftContent(lead(), [], scoreLead(lead(), [], NOW));
    expect(draft.writer).toBe('template-v1');
    expect(draft.promptTokens).toBe(0);
    expect(draft.completionTokens).toBe(0);
    expect(draft.costUsd).toBe(0);
  });

  it('hashes the subject as well as the body', () => {
    expect(contentHash('a', 'body')).not.toBe(contentHash('b', 'body'));
    expect(contentHash('a', 'body')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the ask to the score band', () => {
    const warm = lead();
    const warmDraft = buildDraftContent(warm, [signal({ kind: 'intent', weight: 0.9 })], scoreLead(warm, [signal({ kind: 'intent', weight: 0.9 })], NOW));
    expect(warmDraft.body).toContain('15 minutes');

    const cool = lead({ employees: 20 });
    const coolDraft = buildDraftContent(cool, [], scoreLead(cool, [], NOW));
    expect(coolDraft.body).toContain('two-page outline');
  });

  it('never invents a statistic in the copy', () => {
    // A fabricated customer metric in outreach copy is the fastest way to lose
    // a technical reader. The template carries no percentages at all.
    for (const item of [lead(), lead({ employees: null }), lead({ employees: 2400 })]) {
      const draft = buildDraftContent(item, [signal()], scoreLead(item, [signal()], NOW));
      expect(draft.body).not.toMatch(/\d+\s?%/);
    }
  });

  it('exposes the same behaviour through the async writer interface', async () => {
    const scored = scoreLead(lead(), [], NOW);
    const viaInterface = await templateWriter.write({ lead: lead(), signals: [], score: scored });
    const direct = buildDraftContent(lead(), [], scored);
    expect(viaInterface).toEqual(direct);
  });
});
