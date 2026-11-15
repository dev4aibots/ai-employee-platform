import { describe, expect, it } from 'vitest';
import { computeCostUsd, percentile, summarizeRuns, type RunSample } from '../src/telemetry/cost.js';

describe('cost computation', () => {
  it('prices prompt and completion tokens separately', () => {
    // gpt-4o-mini: 0.15 / 0.60 per 1M
    expect(computeCostUsd('gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15, 8);
    expect(computeCostUsd('gpt-4o-mini', 0, 1_000_000)).toBeCloseTo(0.6, 8);
    expect(computeCostUsd('gpt-4o-mini', 1_000, 500)).toBeCloseTo(0.00015 + 0.0003, 8);
  });

  it('returns null for an unpriced model instead of guessing', () => {
    expect(computeCostUsd('mystery-model-9', 100, 100)).toBeNull();
  });

  it('rejects negative token counts', () => {
    expect(() => computeCostUsd('gpt-4o-mini', -1, 10)).toThrow(/non-negative/);
  });

  it('accepts an override price table', () => {
    const cost = computeCostUsd('custom', 1_000_000, 0, {
      custom: { inputPer1M: 2, outputPer1M: 4 },
    });
    expect(cost).toBe(2);
  });
});

describe('percentiles', () => {
  it('uses nearest-rank so the result is always a real sample', () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 100)).toBe(50);
  });

  it('is order independent', () => {
    expect(percentile([50, 10, 30], 50)).toBe(percentile([30, 50, 10], 50));
  });

  it('returns zero for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('rejects out of range percentiles', () => {
    expect(() => percentile([1], 101)).toThrow(/between 0 and 100/);
  });
});

describe('run summary', () => {
  const runs: RunSample[] = [
    { model: 'gpt-4o-mini', promptTokens: 1_000, completionTokens: 200, latencyMs: 400 },
    { model: 'gpt-4o-mini', promptTokens: 2_000, completionTokens: 400, latencyMs: 900 },
    { model: 'claude-sonnet-4.6', promptTokens: 3_000, completionTokens: 600, latencyMs: 2_500 },
    { model: null, promptTokens: 0, completionTokens: 0, latencyMs: 100 },
    { model: 'unknown-model', promptTokens: 10, completionTokens: 10, latencyMs: 150 },
  ];

  it('counts every run and flags the ones it cannot price', () => {
    const summary = summarizeRuns(runs);
    expect(summary.runs).toBe(5);
    expect(summary.unpricedRuns).toBe(2); // null model + unknown model
  });

  it('sums cost across priced runs', () => {
    const summary = summarizeRuns(runs);
    const expected =
      computeCostUsd('gpt-4o-mini', 1_000, 200)! +
      computeCostUsd('gpt-4o-mini', 2_000, 400)! +
      computeCostUsd('claude-sonnet-4.6', 3_000, 600)!;
    expect(summary.totalCostUsd).toBeCloseTo(expected, 8);
  });

  it('attributes cost per model', () => {
    const summary = summarizeRuns(runs);
    expect(Object.keys(summary.costByModel).sort()).toEqual(['claude-sonnet-4.6', 'gpt-4o-mini']);
    expect(summary.runsByModel['gpt-4o-mini']).toBe(2);
  });

  it('reports latency percentiles over every run, priced or not', () => {
    const summary = summarizeRuns(runs);
    expect(summary.latencyP50Ms).toBe(400);
    expect(summary.latencyP95Ms).toBe(2_500);
  });

  it('handles an empty run set', () => {
    expect(summarizeRuns([])).toMatchObject({ runs: 0, totalCostUsd: 0, latencyP50Ms: 0 });
  });
});
