-- ============================================================
--  Compare a WORKING account against a BROKEN one.
--
--  Read-only. ASCII only.
--
--  The working account (created by GoTrue itself) and the broken
--  one (created by our SQL function) differ in exactly the columns
--  that GoTrue reads when you try to sign in. Diffing the identity
--  rows is the fastest way to see it.
-- ============================================================

with working as (
  -- an account that CAN sign in: created through signUp, or the
  -- boss account made by create-account.sql
  select u.id, u.email
  from auth.users u
  where u.email like '%@boss.pr'
  order by u.created_at desc
  limit 1
),
broken as (
  select u.id, u.email
  from auth.users u
  where u.email like 'auto%@staff.pr' or u.email like 'diag%@staff.pr'
  order by u.created_at desc
  limit 1
)
select
  'WORKING' as which,
  w.email,
  i.provider,
  i.provider_id,
  i.identity_data::text as identity_data,
  i.id::text as identity_row_id,
  u.id::text as user_id
from working w
join auth.users u on u.id = w.id
left join auth.identities i on i.user_id = w.id

union all

select
  'BROKEN' as which,
  b.email,
  i.provider,
  i.provider_id,
  i.identity_data::text as identity_data,
  i.id::text as identity_row_id,
  u.id::text as user_id
from broken b
join auth.users u on u.id = b.id
left join auth.identities i on i.user_id = b.id;
