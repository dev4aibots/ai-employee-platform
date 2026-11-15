/**
 * Cost and latency telemetry.
 *
 * "The agent is cheap enough" is not an engineering statement. Every run writes
 * model, token counts, latency and a computed cost, so the platform can answer
 * per-tenant questions with numbers: what does this tenant cost per resolved
 * ticket, and which model is carrying the p95.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/**
 * Planning prices, in USD per million tokens. Replace with the provider's
 * current sheet; the numbers below are deliberately conservative so an estimate
 * never under-reports spend.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'claude-haiku-4.5': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4.6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'llama-3.3-70b': { inputPer1M: 0.59, outputPer1M: 0.79 },
};

export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): number | null {
  const price = prices[model];
  if (!price) return null;
  if (promptTokens < 0 || completionTokens < 0) {
    throw new Error('token counts must be non-negative');
  }
  const cost = (promptTokens / 1_000_000) * price.inputPer1M + (completionTokens / 1_000_000) * price.outputPer1M;
  return Number(cost.toFixed(8));
}

export interface RunSample {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface TelemetrySummary {
  runs: number;
  totalCostUsd: number;
  /** Runs whose model is absent from the price table; they are excluded from cost. */
  unpricedRuns: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  costByModel: Record<string, number>;
  runsByModel: Record<string, number>;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p < 0 || p > 100) throw new Error('percentile must be between 0 and 100');
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method: deterministic and easy to audit against a spreadsheet.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function summarizeRuns(runs: readonly RunSample[]): TelemetrySummary {
  const latencies = runs.map((r) => r.latencyMs);
  const costByModel: Record<string, number> = {};
  const runsByModel: Record<string, number> = {};
  let totalCostUsd = 0;
  let unpricedRuns = 0;

  for (const run of runs) {
    if (run.model) {
      runsByModel[run.model] = (runsByModel[run.model] ?? 0) + 1;
    }
    const cost = run.model ? computeCostUsd(run.model, run.promptTokens, run.completionTokens) : null;
    if (cost === null) {
      unpricedRuns += 1;
      continue;
    }
    totalCostUsd += cost;
    if (run.model) {
      costByModel[run.model] = Number(((costByModel[run.model] ?? 0) + cost).toFixed(8));
    }
  }

  return {
    runs: runs.length,
    totalCostUsd: Number(totalCostUsd.toFixed(8)),
    unpricedRuns,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    costByModel,
    runsByModel,
  };
}
