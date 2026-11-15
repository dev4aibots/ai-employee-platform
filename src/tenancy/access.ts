/**
 * Access resolution: the single decision point for "may this tenant use the
 * product right now?".
 *
 * It is a pure function on purpose. All four billing states, the trial window,
 * the superadmin bypass and the seat cap are decided here with an injected
 * clock, which makes every branch testable without a database, a Stripe webhook
 * or a wall clock.
 *
 * Precedence is explicit and ordered — the bug this replaces treated
 * `past_due` as active because the checks were written in the wrong order.
 */

import { PLANS, type Feature, type PlanId, planAllows, seatLimit } from '../billing/plans.js';

export interface TenantProfile {
  id: string;
  email: string;
  plan: PlanId;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  trialEndsAt: Date | string;
  seats: number;
  isSuperadmin: boolean;
  pastDueSince?: Date | string | null;
}

export type AccessCode =
  | 'ok'
  | 'superadmin'
  | 'trial_active'
  | 'past_due_grace'
  | 'no_profile'
  | 'trial_expired'
  | 'past_due'
  | 'canceled'
  | 'seat_limit'
  | 'feature_not_in_plan';

export interface AccessDecision {
  allowed: boolean;
  code: AccessCode;
  /** Human-readable explanation, safe to show a tenant. */
  reason: string;
  /** How access was granted, when it was. */
  source?: 'superadmin' | 'subscription' | 'trial' | 'grace';
}

export interface AccessInput {
  profile: TenantProfile | null;
  /** Injected clock. */
  now: Date;
  /** Features the caller intends to use. */
  requires?: readonly Feature[];
  /** Occupied seats, when the caller knows them. */
  activeSeats?: number;
  /** Grace granted after a failed payment. Default 3 days. */
  pastDueGraceDays?: number;
}

const DEFAULT_GRACE_DAYS = 3;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function resolveAccess(input: AccessInput): AccessDecision {
  const { profile, now, requires = [], activeSeats, pastDueGraceDays = DEFAULT_GRACE_DAYS } = input;

  if (!profile) {
    return { allowed: false, code: 'no_profile', reason: 'No account found for this session.' };
  }

  if (profile.isSuperadmin) {
    return {
      allowed: true,
      code: 'superadmin',
      source: 'superadmin',
      reason: 'Operator account with full access.',
    };
  }

  // Hard stops first: a canceled account is canceled regardless of trial dates.
  if (profile.status === 'canceled') {
    return {
      allowed: false,
      code: 'canceled',
      reason: 'Subscription canceled. Reactivate to continue.',
    };
  }

  if (profile.status === 'past_due') {
    const since = profile.pastDueSince ? toDate(profile.pastDueSince) : null;
    const graceMs = pastDueGraceDays * 24 * 60 * 60 * 1000;
    const withinGrace = since !== null && now.getTime() - since.getTime() <= graceMs;
    if (!withinGrace) {
      return {
        allowed: false,
        code: 'past_due',
        reason: 'Payment failed. Update the payment method to restore access.',
      };
    }
  }

  if (profile.status === 'trialing') {
    const endsAt = toDate(profile.trialEndsAt);
    if (endsAt.getTime() <= now.getTime()) {
      return {
        allowed: false,
        code: 'trial_expired',
        reason: 'Trial ended. Choose a plan to keep your AI employees running.',
      };
    }
  }

  // Seat cap applies to everyone except superadmins (handled above).
  if (typeof activeSeats === 'number' && activeSeats > seatLimit(profile.plan)) {
    return {
      allowed: false,
      code: 'seat_limit',
      reason: `Plan "${PLANS[profile.plan].label}" allows ${seatLimit(profile.plan)} seats; ${activeSeats} are in use.`,
    };
  }

  for (const feature of requires) {
    if (!planAllows(profile.plan, feature)) {
      return {
        allowed: false,
        code: 'feature_not_in_plan',
        reason: `"${feature}" is not included in the ${PLANS[profile.plan].label} plan.`,
      };
    }
  }

  if (profile.status === 'past_due') {
    return {
      allowed: true,
      code: 'past_due_grace',
      source: 'grace',
      reason: 'Access continues during the payment grace period.',
    };
  }

  if (profile.status === 'trialing') {
    return {
      allowed: true,
      code: 'trial_active',
      source: 'trial',
      reason: 'Trial is active.',
    };
  }

  return {
    allowed: true,
    code: 'ok',
    source: 'subscription',
    reason: 'Subscription active.',
  };
}
