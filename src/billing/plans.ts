/**
 * Plan catalogue and entitlements.
 *
 * Kept as data rather than scattered `if (plan === 'growth')` checks so a
 * pricing change is one edit and the tests cover every branch.
 */

export type PlanId = 'trial' | 'starter' | 'growth' | 'scale';

export type Feature =
  | 'support_agent'
  | 'sales_agent'
  | 'scheduled_agents'
  | 'custom_tools'
  | 'rag_knowledge_base'
  | 'audit_export'
  | 'sso';

export interface Plan {
  id: PlanId;
  label: string;
  monthlyUsd: number | null;
  seats: number;
  includedRuns: number;
  features: readonly Feature[];
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  trial: {
    id: 'trial',
    label: 'Trial',
    monthlyUsd: 0,
    seats: 1,
    includedRuns: 100,
    features: ['support_agent'],
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    monthlyUsd: 49,
    seats: 3,
    includedRuns: 2_000,
    features: ['support_agent', 'sales_agent', 'rag_knowledge_base'],
  },
  growth: {
    id: 'growth',
    label: 'Growth',
    monthlyUsd: 199,
    seats: 15,
    includedRuns: 25_000,
    features: [
      'support_agent',
      'sales_agent',
      'scheduled_agents',
      'rag_knowledge_base',
      'custom_tools',
      'audit_export',
    ],
  },
  scale: {
    id: 'scale',
    label: 'Scale',
    monthlyUsd: null,
    seats: 500,
    includedRuns: 500_000,
    features: [
      'support_agent',
      'sales_agent',
      'scheduled_agents',
      'rag_knowledge_base',
      'custom_tools',
      'audit_export',
      'sso',
    ],
  },
};

export function isPlanId(value: string): value is PlanId {
  return Object.prototype.hasOwnProperty.call(PLANS, value);
}

export function planAllows(plan: PlanId, feature: Feature): boolean {
  return PLANS[plan].features.includes(feature);
}

export function seatLimit(plan: PlanId): number {
  return PLANS[plan].seats;
}

/**
 * Which plan a Stripe/PayPal price maps to. Unknown prices are rejected rather
 * than silently defaulting to the most generous plan.
 */
export function planForPrice(priceId: string, table: Record<string, PlanId> = PRICE_TABLE): PlanId | null {
  return table[priceId] ?? null;
}

/** Replace with real price ids from the billing provider. */
export const PRICE_TABLE: Record<string, PlanId> = {
  price_starter_monthly: 'starter',
  price_growth_monthly: 'growth',
  price_scale_annual: 'scale',
};

export interface UsageBill {
  overageRuns: number;
  overageUsd: number;
}

/**
 * Metered overage. $0.004 per run beyond the plan allowance — deliberately
 * boring arithmetic so it is trivially auditable against an invoice.
 */
export const OVERAGE_USD_PER_RUN = 0.004;

export function billUsage(plan: PlanId, runs: number): UsageBill {
  const overageRuns = Math.max(0, runs - PLANS[plan].includedRuns);
  return {
    overageRuns,
    overageUsd: Number((overageRuns * OVERAGE_USD_PER_RUN).toFixed(4)),
  };
}
