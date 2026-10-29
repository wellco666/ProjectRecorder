-- ============================================================
--  Compare EVERY column of a working vs a broken auth.users row.
--
--  Read-only. ASCII only.
--
--  Columns that differ are listed first.
--  Earlier version failed with "syntax error at or near =" because
--  a comparison inside ORDER BY was split across lines. This one
--  keeps the expression on a single line and precomputes the
--  comparison in a CTE instead of repeating it.
-- ============================================================

with cols as (
  select column_name
  from information_schema.columns
  where table_schema = 'auth' and table_name = 'users'
),
working as (
  select * from auth.users
  where email like '%@boss.pr'
  order by created_at desc limit 1
),
broken as (
  select * from auth.users
  where email like 'auto%@staff.pr' or email like 'diag%@staff.pr'
  order by created_at desc limit 1
),
pairs as (
  select
    c.column_name as col,
    coalesce(to_jsonb(w) ->> c.column_name, '(null)') as working_value,
    coalesce(to_jsonb(b) ->> c.column_name, '(null)') as broken_value
  from cols c
  cross join working w
  cross join broken b
)
select
  col,
  working_value,
  broken_value,
  case when working_value = broken_value then 'same' else 'DIFFERENT' end as verdict
from pairs
order by (working_value = broken_value), col;
