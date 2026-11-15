-- ===========================================================================
-- ai-employee-platform :: row level security
--
-- Tenancy model: every tenant-owned row carries user_id = profiles.id. The
-- policies below are the ONLY thing standing between tenant A and tenant B,
-- so they are treated as security-critical code and covered by the adversarial
-- suite in tests/rls.test.ts.
--
-- Roles mirror Supabase:
--   authenticated — a logged-in tenant, subject to RLS
--   anon          — no session, must see nothing
--   service_role  — server-side operations, bypasses RLS by design
-- ===========================================================================

alter table profiles          enable row level security;
alter table credentials       enable row level security;
alter table employees         enable row level security;
alter table messages          enable row level security;
alter table documents         enable row level security;
alter table webhook_receipts  enable row level security;
alter table workflow_runs     enable row level security;
alter table audit_log         enable row level security;

-- Force RLS for table owners too; otherwise a owner-role connection silently
-- ignores every policy and the security model is decorative.
alter table profiles          force row level security;
alter table credentials       force row level security;
alter table employees         force row level security;
alter table messages          force row level security;
alter table documents         force row level security;
alter table webhook_receipts  force row level security;
alter table workflow_runs     force row level security;
alter table audit_log         force row level security;

-- --------------------------------------------------------------------------
-- profiles: read and update your own row. Creation is handled by the signup
-- trigger on auth.users (service role), so tenants get no INSERT policy.
-- --------------------------------------------------------------------------
drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own on profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- --------------------------------------------------------------------------
-- credentials: a tenant owns its vault entries and nothing else. No SELECT of
-- another tenant's ciphertext, and no ability to write a row owned by someone
-- else (that is what the WITH CHECK clause prevents).
-- --------------------------------------------------------------------------
drop policy if exists credentials_tenant_all on credentials;
create policy credentials_tenant_all on credentials
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- employees
-- --------------------------------------------------------------------------
drop policy if exists employees_tenant_all on employees;
create policy employees_tenant_all on employees
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- messages: readable only inside the tenant.
-- --------------------------------------------------------------------------
drop policy if exists messages_tenant_select on messages;
create policy messages_tenant_select on messages
  for select to authenticated
  using (auth.uid() = user_id);

-- Checking user_id alone is not enough: without the EXISTS clause a tenant can
-- attach a message to another tenant's employee id, which is a cross-tenant
-- reference even though the row itself looks "owned". The reference must be
-- validated against a row the caller can actually see.
drop policy if exists messages_tenant_insert on messages;
create policy messages_tenant_insert on messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from employees e
      where e.id = messages.employee_id
        and e.user_id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- documents: the RAG corpus. Same isolation rule as everything else.
-- --------------------------------------------------------------------------
drop policy if exists documents_tenant_all on documents;
create policy documents_tenant_all on documents
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- workflow_runs: a tenant can read its own cost/latency rows but cannot forge
-- or mutate them; only the service role writes them.
-- --------------------------------------------------------------------------
drop policy if exists workflow_runs_tenant_select on workflow_runs;
create policy workflow_runs_tenant_select on workflow_runs
  for select to authenticated
  using (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- audit_log: append-only and tenant-scoped. There is deliberately no UPDATE or
-- DELETE policy, so a compromised tenant session cannot rewrite history.
-- The service role writes entries; the tenant reads its own.
-- --------------------------------------------------------------------------
drop policy if exists audit_log_tenant_select on audit_log;
create policy audit_log_tenant_select on audit_log
  for select to authenticated
  using (user_id is null or auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- webhook_receipts: internal bookkeeping. No tenant-facing policy at all, so
-- an authenticated session sees zero rows and the service role does all work.
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- anon: explicitly nothing. Revoking default grant makes the intent explicit
-- instead of relying on "no policy happens to deny it".
-- --------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
