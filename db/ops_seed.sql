-- ===========================================================================
-- ai-employee-platform :: deterministic operations fixture
--
-- 140 leads for tenant A (Acme Robotics), generated from modulo arithmetic so
-- every run of the demo sees the same pipeline. No random(), no now() drift
-- beyond the relative timestamps.
-- ===========================================================================

set app.privileged = 'on';

insert into leads (user_id, company, domain, contact_name, contact_role, contact_email, source, stage,
                   employees, funding_stage, hq_city, last_contact_at, replied_at, created_at)
select
  '11111111-1111-4111-8111-111111111111'::uuid,
  (array['Kestrel','Lumen','Northwind','Saffron','Verdant','Cobalt','Meridian','Bluebird','Anvil','Trellis','Harbor','Quarry','Summit','Onyx','Willow','Basalt','Indigo','Beacon','Cedar','Fathom'])[1 + (i % 20)]
    || ' ' ||
  (array['HR','Payroll','People','Workforce','Talent'])[1 + (i % 5)]
    || ' ' || (1 + i / 20)::text,
  'c' || i::text || '.example',
  (array['Aarav','Diya','Kabir','Meera','Rohan','Ishita','Advait','Nisha','Vikram','Ananya','Dev','Priya'])[1 + (i % 12)]
    || ' ' ||
  (array['Shah','Iyer','Patel','Rao','Mehta','Nair','Singh','Kulkarni','Desai'])[1 + (i % 9)],
  (array['Head of People','VP Engineering','Founder','HR Ops Lead','CTO','People Partner'])[1 + (i % 6)],
  'lead' || i::text || '@c' || i::text || '.example',
  (array['inbound','outbound','referral','event','partner'])[1 + (i % 5)],
  case
    when i % 100 < 10 then 'new'
    when i % 100 < 35 then 'qualified'
    when i % 100 < 60 then 'contacted'
    when i % 100 < 68 then 'replied'
    when i % 100 < 74 then 'meeting'
    when i % 100 < 80 then 'won'
    when i % 100 < 90 then 'lost'
    else 'disqualified'
  end,
  (array[30, 55, 80, 120, 200, 350, 600, 900, 1500, 2500])[1 + (i % 10)],
  (array['bootstrapped','seed','series_a','series_b','series_c','public'])[1 + (i % 6)],
  (array['Bengaluru','Pune','Hyderabad','Gurugram','Mumbai','Ahmedabad','Chennai','Noida'])[1 + (i % 8)],
  case
    when i % 100 < 10 then null
    when i % 100 < 35 then now() - (make_interval(days => 8 + (i % 25)))
    when i % 100 < 60 then now() - (make_interval(days => 3 + (i % 40)))
    else now() - (make_interval(days => 2 + (i % 10)))
  end,
  case
    when i % 100 >= 60 and i % 100 < 80 then now() - (make_interval(days => 1 + (i % 8)))
    else null
  end,
  now() - (make_interval(days => 5 + (i % 120)))
from generate_series(1, 140) as g(i);

-- Enrichment signals: every third lead carries one, and every ninth carries a
-- friction note. The weights are what the scorer uses; changing them here
-- changes the ranking without touching code.
insert into lead_signals (user_id, lead_id, kind, value, weight)
select l.user_id, l.id, s.kind, s.value, s.weight
from leads l
join generate_series(1, 140) as g(i) on l.domain = 'c' || i::text || '.example'
join (values
  (0, 'intent',  'visited the pricing page three times in 14 days', 0.900::numeric),
  (1, 'hiring',  'posted three people-ops roles this week',        0.700::numeric),
  (2, 'funding', 'closed a Series B in October 2026',              0.800::numeric),
  (3, 'tech',    'runs HubSpot and Postgres, inside the integration path', 0.500::numeric)
) as s(mod, kind, value, weight) on (i % 4) = s.mod
where l.user_id = '11111111-1111-4111-8111-111111111111'::uuid
  and i % 3 = 0;

insert into lead_signals (user_id, lead_id, kind, value, weight)
select l.user_id, l.id, 'friction', 'public review mentions a four-day support queue', -0.400::numeric
from leads l
join generate_series(1, 140) as g(i) on l.domain = 'c' || i::text || '.example'
where l.user_id = '11111111-1111-4111-8111-111111111111'::uuid
  and i % 9 = 0;

reset app.privileged;
