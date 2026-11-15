-- ===========================================================================
-- ai-employee-platform :: deterministic demo data
--
-- Two competing tenants, each with its own employees, documents and audit
-- history. Used by the test suite as the adversarial fixture (A must never see
-- B) and by the demo CLI.
-- ===========================================================================

-- Fixed ids so tests can reason about them without a lookup round trip.
-- Tenant A = Acme Robotics, tenant B = Globex Logistics.

set app.privileged = 'on';

insert into profiles (id, email, company_name, plan, status, trial_ends_at, seats)
values
  ('11111111-1111-4111-8111-111111111111', 'ops@acme.test',   'Acme Robotics',   'growth',  'active',   now() - interval '1 day', 5),
  ('22222222-2222-4222-8222-222222222222', 'ops@globex.test', 'Globex Logistics', 'starter', 'active',   now() - interval '1 day', 2)
on conflict (id) do nothing;

insert into employees (id, user_id, kind, name, status)
values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'support',  'Acme Support Agent',  'online'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'sales',    'Globex Lead Agent',   'online')
on conflict (id) do nothing;

insert into documents (id, user_id, title, content, embedding)
values
  ('dddddddd-1111-4111-8111-dddddddddddd',
   '11111111-1111-4111-8111-111111111111',
   'Acme refund policy',
   'Refunds are available within 30 days of purchase for unused hardware.',
   array[0.9, 0.1, 0.0]::double precision[]),
  ('eeeeeeee-2222-4222-8222-eeeeeeeeeeee',
   '22222222-2222-4222-8222-222222222222',
   'Globex freight SLA',
   'Freight shipments are delivered within 5 business days across EMEA.',
   array[0.0, 0.9, 0.1]::double precision[])
on conflict (id) do nothing;

insert into messages (user_id, employee_id, role, content)
values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'user',  'Can I still refund a unit bought 20 days ago?'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'agent', 'Yes - 20 days is inside the 30 day window.'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'user',  'What is the EMEA delivery SLA?');

reset app.privileged;
