import { describe, expect, it } from 'vitest';
import {
  billUsage,
  isPlanId,
  OVERAGE_USD_PER_RUN,
  PLANS,
  planAllows,
  planForPrice,
  seatLimit,
} from '../src/billing/plans.js';

describe('plan catalogue', () => {
  it('exposes every plan with a positive seat allowance', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.seats).toBeGreaterThan(0);
      expect(plan.includedRuns).toBeGreaterThan(0);
      expect(plan.features.length).toBeGreaterThan(0);
    }
  });

  it('escalates entitlements with price', () => {
    expect(seatLimit('trial')).toBeLessThan(seatLimit('starter'));
    expect(seatLimit('starter')).toBeLessThan(seatLimit('growth'));
    expect(seatLimit('growth')).toBeLessThan(seatLimit('scale'));
  });

  it('identifies valid plan ids', () => {
    expect(isPlanId('growth')).toBe(true);
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId('toString')).toBe(false);
  });
});

describe('feature gating', () => {
  it('grants a feature only on plans that list it', () => {
    expect(planAllows('trial', 'support_agent')).toBe(true);
    expect(planAllows('trial', 'sso')).toBe(false);
    expect(planAllows('scale', 'sso')).toBe(true);
    expect(planAllows('starter', 'audit_export')).toBe(false);
    expect(planAllows('growth', 'audit_export')).toBe(true);
  });
});

describe('price mapping', () => {
  it('maps a known price id to a plan', () => {
    expect(planForPrice('price_growth_monthly')).toBe('growth');
  });

  it('returns null for an unknown price instead of defaulting to the best plan', () => {
    expect(planForPrice('price_does_not_exist')).toBeNull();
  });
});

describe('metered overage', () => {
  it('charges nothing inside the allowance', () => {
    expect(billUsage('starter', 1_500)).toEqual({ overageRuns: 0, overageUsd: 0 });
  });

  it('charges exactly at the boundary', () => {
    expect(billUsage('starter', PLANS.starter.includedRuns)).toEqual({
      overageRuns: 0,
      overageUsd: 0,
    });
  });

  it('charges per run beyond the allowance', () => {
    const bill = billUsage('starter', PLANS.starter.includedRuns + 1_000);
    expect(bill.overageRuns).toBe(1_000);
    expect(bill.overageUsd).toBe(Number((1_000 * OVERAGE_USD_PER_RUN).toFixed(4)));
  });

  it('never returns a negative bill', () => {
    expect(billUsage('scale', 0).overageUsd).toBe(0);
  });
});
