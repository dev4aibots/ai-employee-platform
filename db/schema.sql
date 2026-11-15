-- ===========================================================================
-- ai-employee-platform :: core schema (portable Postgres 15+)
--
-- Portable on purpose: it runs unchanged on Supabase/Postgres and on the
-- in-process PGlite test harness, so the tests exercise the real SQL rather
-- than a mock. pgvector is optional — see db/pgvector.sql for the production
-- upgrade that swaps embedding double precision[] for vector(1536).
-- ===========================================================================

create schema if not exists auth;

-- Supabase exposes the caller's JWT subject as auth.uid(). Every RLS policy
-- below is written against it, so the same policies work in production and in
-- tests (the harness sets request.jwt.claim.sub to impersonate a tenant).
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to public;
grant execute on function auth.uid() to public;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id                  uuid primary key,
  email               text not null unique,
  company_name        text,
  plan                text not null default 'trial'
                      check (plan in ('trial', 'starter', 'growth', 'scale')),
  status              text not null default 'trialing'
                      check (status in ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at       timestamptz not null default (now() + interval '14 days'),
  seats               integer not null default 1 check (seats between 1 and 500),
  is_superadmin       boolean not null default false,
  billing_customer_id text,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Encrypted third-party credentials. One row per tenant per provider.
-- ciphertext is AES-256-GCM, formatted "v<keyVersion>:<b64 iv>:<b64 ct>:<b64 tag>".
-- The vault never stores plaintext and never logs it.
-- ---------------------------------------------------------------------------
create table if not exists credentials (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  provider    text not null check (length(provider) between 1 and 64),
  ciphertext  text not null,
  key_version text not null,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  unique (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Deployed AI employees
-- ---------------------------------------------------------------------------
create table if not exists employees (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  kind       text not null,
  name       text not null,
  status     text not null default 'online'
             check (status in ('online', 'paused', 'error')),
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists employees_user_idx on employees (user_id);

-- ---------------------------------------------------------------------------
-- Conversation log
-- ---------------------------------------------------------------------------
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  role        text not null check (role in ('user', 'agent', 'system', 'tool')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists messages_user_idx on messages (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Knowledge base. embedding is double precision[] in the portable schema and
-- becomes vector(1536) after db/pgvector.sql. Retrieval uses cosine_similarity
-- either way, so the query path is identical in tests and production.
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  title      text not null,
  content    text not null,
  embedding  double precision[],
  created_at timestamptz not null default now()
);
create index if not exists documents_user_idx on documents (user_id);

create or replace function cosine_similarity(a double precision[], b double precision[])
returns double precision
language plpgsql immutable
as $$
declare
  dot double precision := 0;
  na  double precision := 0;
  nb  double precision := 0;
  i   integer;
begin
  if a is null or b is null or array_length(a, 1) is distinct from array_length(b, 1) then
    return null;
  end if;
  for i in 1 .. array_length(a, 1) loop
    dot := dot + (a[i] * b[i]);
    na  := na + (a[i] * a[i]);
    nb  := nb + (b[i] * b[i]);
  end loop;
  if na = 0 or nb = 0 then
    return 0;
  end if;
  return dot / (sqrt(na) * sqrt(nb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Webhook idempotency. The primary key IS the idempotency key, so a duplicate
-- delivery cannot create a second row: `insert ... on conflict do nothing`
-- returns zero rows on replay. payload_sha256 detects key reuse with a
-- different body, which is a bug or an attack, never a normal retry.
-- ---------------------------------------------------------------------------
create table if not exists webhook_receipts (
  idempotency_key text primary key,
  provider        text not null,
  event_id        text not null,
  payload_sha256  text not null,
  status          text not null default 'claimed'
                  check (status in ('claimed', 'processed', 'failed')),
  attempts        integer not null default 0,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index if not exists webhook_receipts_event_idx on webhook_receipts (provider, event_id);

-- ---------------------------------------------------------------------------
-- One row per agent invocation. This is the cost and latency ledger.
-- ---------------------------------------------------------------------------
create table if not exists workflow_runs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  employee_id       uuid references employees(id) on delete set null,
  trace_id          text not null,
  status            text not null default 'running'
                    check (status in ('running', 'succeeded', 'failed', 'dead_letter')),
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(12, 6),
  latency_ms        integer,
  error             text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists workflow_runs_user_idx on workflow_runs (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Hash-chained audit ledger. entry_hash = sha256(prev_hash || canonical_json).
-- The application writes it (src/audit/ledger.ts) so the chain is verifiable
-- independently of the database; audit_log is append-only by policy.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  seq        bigserial primary key,
  user_id    uuid,
  actor      text not null,
  action     text not null,
  subject    text,
  payload    jsonb not null default '{}'::jsonb,
  prev_hash  text not null,
  entry_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_user_idx on audit_log (user_id, seq desc);

-- ---------------------------------------------------------------------------
-- Privilege guard: a tenant may edit its own profile fields, but must never be
-- able to grant itself a paid plan, extra seats, an extended trial, or
-- superadmin. Only a privileged connection (service role, or a session that
-- sets app.privileged='on') can change those columns.
-- ---------------------------------------------------------------------------
create or replace function guard_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.privileged', true), 'off') = 'on' then
    return new;
  end if;

  if new.plan is distinct from old.plan
     or new.status is distinct from old.status
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.seats is distinct from old.seats
     or new.is_superadmin is distinct from old.is_superadmin
     or new.billing_customer_id is distinct from old.billing_customer_id then
    raise exception 'privilege_escalation_blocked: plan, status, trial_ends_at, seats, is_superadmin and billing_customer_id are service-role only'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_privilege_guard on profiles;
create trigger profiles_privilege_guard
  before update on profiles
  for each row execute function guard_profile_privileges();
