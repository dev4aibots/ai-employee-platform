-- ===========================================================================
-- ai-employee-platform :: business operations domain
--
-- The core schema models tenancy, credentials, employees and documents. This
-- file adds the objects an AI employee actually operates on when the job is
-- "work the pipeline": leads, enrichment signals, drafted outreach, approval
-- decisions, sends, and the run ledger that records what the agent did.
--
-- Same rules as the core schema: portable Postgres, every tenant-owned row
-- carries user_id = profiles.id, and RLS is enabled and forced.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table if not exists leads (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  company         text not null check (length(company) between 1 and 160),
  domain          text not null check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  contact_name    text not null,
  contact_role    text not null,
  contact_email   text not null,
  source          text not null check (source in ('inbound', 'outbound', 'referral', 'event', 'partner')),
  stage           text not null default 'new'
                  check (stage in ('new', 'qualified', 'contacted', 'replied', 'meeting', 'won', 'lost', 'disqualified')),
  employees       integer check (employees between 1 and 100000),
  funding_stage   text check (funding_stage in ('bootstrapped', 'seed', 'series_a', 'series_b', 'series_c', 'public')),
  hq_city         text,
  last_contact_at timestamptz,
  replied_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, domain)
);

create index if not exists leads_user_stage_idx      on leads (user_id, stage);
create index if not exists leads_user_contact_idx    on leads (user_id, last_contact_at desc);
create index if not exists leads_user_source_idx     on leads (user_id, source);

-- ---------------------------------------------------------------------------
-- Enrichment signals. One row per observed fact, with the weight the scorer
-- uses. Keeping weight on the row (not in code) means the scoring model can be
-- audited per lead and re-tuned without a deploy.
-- ---------------------------------------------------------------------------
create table if not exists lead_signals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  kind        text not null check (kind in ('hiring', 'funding', 'tech', 'traffic', 'intent', 'friction')),
  value       text not null check (length(value) between 1 and 240),
  weight      numeric(4, 3) not null check (weight between -1 and 1),
  observed_at timestamptz not null default now()
);

create index if not exists lead_signals_lead_idx on lead_signals (lead_id);

-- ---------------------------------------------------------------------------
-- Drafts. content_hash is unique per tenant, which is what makes "draft the
-- same lead twice" idempotent instead of producing duplicate outreach.
-- ---------------------------------------------------------------------------
create table if not exists drafts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  lead_id            uuid not null references leads(id) on delete cascade,
  subject            text not null check (length(subject) between 1 and 200),
  body               text not null check (length(body) between 1 and 4000),
  status             text not null default 'pending'
                     check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  content_hash       text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  writer             text not null,
  prompt_tokens      integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens  integer not null default 0 check (completion_tokens >= 0),
  cost_usd           numeric(10, 6) not null default 0 check (cost_usd >= 0),
  created_at         timestamptz not null default now(),
  unique (user_id, content_hash)
);

create index if not exists drafts_user_status_idx on drafts (user_id, status, created_at desc);
create index if not exists drafts_lead_idx        on drafts (lead_id);

-- ---------------------------------------------------------------------------
-- Approval decisions. draft_id is unique: a draft is decided exactly once, so
-- a retried approval cannot flip a rejection into an approval.
-- ---------------------------------------------------------------------------
create table if not exists approvals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  draft_id   uuid not null unique references drafts(id) on delete cascade,
  -- Monotonic per tenant. The chain has to be ordered by something that is
  -- unique, otherwise two decisions in the same millisecond can verify in a
  -- different order than they were written.
  seq        integer not null check (seq >= 1),
  decision   text not null check (decision in ('approved', 'rejected')),
  actor      text not null,
  note       text,
  decided_at timestamptz not null default now(),
  entry_hash text not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  unique (user_id, seq)
);

create index if not exists approvals_user_idx on approvals (user_id, seq desc);

-- ---------------------------------------------------------------------------
-- Sends. One row per draft at most; the provider call is claimed before it is
-- made, so a retry after a timeout cannot double-send.
-- ---------------------------------------------------------------------------
create table if not exists sends (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references profiles(id) on delete cascade,
  draft_id            uuid not null unique references drafts(id) on delete cascade,
  provider            text not null,
  provider_message_id text,
  status              text not null check (status in ('sending', 'sent', 'dry_run', 'failed')),
  attempts            integer not null default 1 check (attempts >= 1),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);

create index if not exists sends_user_idx on sends (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Run ledger. One row per agent invocation, one row per step, so the console
-- can show what happened without parsing logs.
-- ---------------------------------------------------------------------------
create table if not exists ops_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  goal        text not null check (length(goal) between 1 and 500),
  status      text not null default 'running'
              check (status in ('running', 'awaiting_approval', 'completed', 'failed')),
  leads_seen  integer not null default 0,
  drafts_made integer not null default 0,
  tokens      integer not null default 0,
  cost_usd    numeric(10, 6) not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ops_runs_user_idx on ops_runs (user_id, started_at desc);

create table if not exists ops_run_steps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  run_id     uuid not null references ops_runs(id) on delete cascade,
  seq        integer not null check (seq >= 0),
  name       text not null,
  status     text not null check (status in ('ok', 'retried', 'failed')),
  attempts   integer not null default 1 check (attempts >= 1),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  detail     jsonb not null default '{}'::jsonb,
  error      text,
  unique (run_id, seq)
);

create index if not exists ops_run_steps_run_idx on ops_run_steps (run_id, seq);

-- ---------------------------------------------------------------------------
-- Read model for the console. security_invoker makes the view obey the
-- caller's RLS instead of the view owner's, which is the difference between a
-- dashboard and a data leak.
-- ---------------------------------------------------------------------------
create or replace view lead_pipeline
with (security_invoker = true) as
select
  l.user_id,
  count(*)                                                        as total,
  count(*) filter (where l.stage = 'qualified')                    as qualified,
  count(*) filter (where l.stage = 'contacted')                    as contacted,
  count(*) filter (where l.stage = 'replied')                      as replied,
  count(*) filter (where l.stage = 'meeting')                      as meeting,
  count(*) filter (where l.stage = 'won')                          as won,
  count(*) filter (where l.replied_at is not null)                 as ever_replied,
  coalesce(sum(l.employees), 0)                                    as employees_reached
from leads l
group by l.user_id;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table leads         enable row level security;
alter table lead_signals  enable row level security;
alter table drafts        enable row level security;
alter table approvals     enable row level security;
alter table sends         enable row level security;
alter table ops_runs      enable row level security;
alter table ops_run_steps enable row level security;

alter table leads         force row level security;
alter table lead_signals  force row level security;
alter table drafts        force row level security;
alter table approvals     force row level security;
alter table sends         force row level security;
alter table ops_runs      force row level security;
alter table ops_run_steps force row level security;

drop policy if exists leads_rw on leads;
create policy leads_rw on leads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists lead_signals_rw on lead_signals;
create policy lead_signals_rw on lead_signals
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists drafts_rw on drafts;
create policy drafts_rw on drafts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists approvals_rw on approvals;
create policy approvals_rw on approvals
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists sends_rw on sends;
create policy sends_rw on sends
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists ops_runs_rw on ops_runs;
create policy ops_runs_rw on ops_runs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists ops_run_steps_rw on ops_run_steps;
create policy ops_run_steps_rw on ops_run_steps
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Read-only access for anon is intentionally absent: a public visitor must see
-- nothing. The console authenticates as the seeded tenant.

-- ---------------------------------------------------------------------------
-- Grants
--
-- db/roles.sql runs before this file, so its `grant ... on all tables` does not
-- cover the objects created above. Without these, `authenticated` is denied at
-- the grant level and RLS never even runs.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete
  on leads, lead_signals, drafts, approvals, sends, ops_runs, ops_run_steps
  to authenticated, service_role;

grant select on lead_pipeline to authenticated, service_role;
