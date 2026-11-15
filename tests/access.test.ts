import { describe, expect, it } from 'vitest';
import { resolveAccess, type TenantProfile } from '../src/tenancy/access.js';

const NOW = new Date('2026-11-15T10:00:00.000Z');

function profile(overrides: Partial<TenantProfile> = {}): TenantProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ops@acme.test',
    plan: 'growth',
    status: 'active',
    trialEndsAt: '2026-11-01T00:00:00.000Z',
    seats: 15,
    isSuperadmin: false,
    ...overrides,
  };
}

describe('subscription states', () => {
  it('grants access to an active subscription', () => {
    const decision = resolveAccess({ profile: profile(), now: NOW });
    expect(decision).toMatchObject({ allowed: true, code: 'ok', source: 'subscription' });
  });

  it('denies a canceled account even if the trial date is in the future', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'canceled', trialEndsAt: '2027-01-01T00:00:00.000Z' }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'canceled' });
  });

  it('denies a past_due account with no grace timestamp', () => {
    const decision = resolveAccess({ profile: profile({ status: 'past_due' }), now: NOW });
    expect(decision).toMatchObject({ allowed: false, code: 'past_due' });
  });

  it('allows a past_due account inside the grace window', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'past_due', pastDueSince: '2026-11-14T10:00:00.000Z' }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: true, code: 'past_due_grace', source: 'grace' });
  });

  it('denies a past_due account once the grace window closes', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'past_due', pastDueSince: '2026-11-10T10:00:00.000Z' }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'past_due' });
  });

  it('honours a custom grace length', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'past_due', pastDueSince: '2026-11-10T10:00:00.000Z' }),
      now: NOW,
      pastDueGraceDays: 7,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('trial window', () => {
  it('allows a trial that has not expired', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'trialing', plan: 'trial', trialEndsAt: '2026-11-20T00:00:00.000Z', seats: 1 }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: true, code: 'trial_active', source: 'trial' });
  });

  it('denies a trial that expired one minute ago', () => {
    const decision = resolveAccess({
      profile: profile({
        status: 'trialing',
        plan: 'trial',
        trialEndsAt: '2026-11-15T09:59:00.000Z',
        seats: 1,
      }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'trial_expired' });
  });

  it('treats the expiry instant itself as expired', () => {
    const decision = resolveAccess({
      profile: profile({
        status: 'trialing',
        plan: 'trial',
        trialEndsAt: NOW.toISOString(),
        seats: 1,
      }),
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('operator override and missing accounts', () => {
  it('lets a superadmin through a canceled subscription', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'canceled', isSuperadmin: true, plan: 'trial', seats: 1 }),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: true, code: 'superadmin', source: 'superadmin' });
  });

  it('denies a session with no profile row', () => {
    const decision = resolveAccess({ profile: null, now: NOW });
    expect(decision).toMatchObject({ allowed: false, code: 'no_profile' });
  });
});

describe('seat and feature entitlements', () => {
  it('denies when more seats are occupied than the plan allows', () => {
    const decision = resolveAccess({
      profile: profile({ plan: 'starter', seats: 3 }),
      now: NOW,
      activeSeats: 4,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'seat_limit' });
  });

  it('allows exactly at the seat cap', () => {
    const decision = resolveAccess({
      profile: profile({ plan: 'starter', seats: 3 }),
      now: NOW,
      activeSeats: 3,
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies a feature the plan does not include', () => {
    const decision = resolveAccess({
      profile: profile({ status: 'trialing', plan: 'trial', trialEndsAt: '2026-11-20T00:00:00.000Z', seats: 1 }),
      now: NOW,
      requires: ['sales_agent'],
    });
    expect(decision).toMatchObject({ allowed: false, code: 'feature_not_in_plan' });
  });

  it('allows a feature the plan includes', () => {
    const decision = resolveAccess({
      profile: profile({ plan: 'growth' }),
      now: NOW,
      requires: ['support_agent', 'sales_agent', 'custom_tools'],
    });
    expect(decision.allowed).toBe(true);
  });

  it('reports the first missing feature when several are requested', () => {
    const decision = resolveAccess({
      profile: profile({ plan: 'starter' }),
      now: NOW,
      requires: ['support_agent', 'custom_tools'],
    });
    expect(decision.code).toBe('feature_not_in_plan');
    expect(decision.reason).toContain('custom_tools');
  });
});

describe('decision is total', () => {
  const statuses = ['trialing', 'active', 'past_due', 'canceled'] as const;
  const plans = ['trial', 'starter', 'growth', 'scale'] as const;

  it('always returns a code and a human reason for every combination', () => {
    for (const status of statuses) {
      for (const plan of plans) {
        for (const isSuperadmin of [true, false]) {
          const decision = resolveAccess({
            profile: profile({ status, plan, isSuperadmin }),
            now: NOW,
          });
          expect(decision.code).toBeTruthy();
          expect(decision.reason.length).toBeGreaterThan(0);
          expect(typeof decision.allowed).toBe('boolean');
        }
      }
    }
  });
});
