-- ============================================================
--  Clean up test accounts left behind by the automated tests.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## Where these came from
--
--  e2e-cloud.js, e2e-rpc.js and the browser test pages each create
--  real accounts in order to exercise the real cloud path. They
--  use recognisable prefixes so they can be found and removed:
--
--    testboss*  teststaff*  testother*    (the e2e scripts)
--    uiboss*    uistaff*                 (devtools/e2e-ui.html)
--    auto*      ae*                      (create_staff_account runs)
--    mb*        sa*        sb*           (e2e-multiboss.js)
--    diag*      probe*                   (one-off diagnostics)
--
--  ## Safety
--
--  Step 1 only LOOKS. Run it first and read the output: if a real
--  account of yours is listed, add its code to the KEEP list in
--  step 2 before deleting anything.
--
--  Step 2 matches those prefixes and an explicit allow-list. No
--  real staff member can match a prefix like "testother" by
--  accident, but the allow-list makes it checkable by eye.
-- ============================================================

-- ============================================================
--  STEP 1 -- look first (read only, changes nothing)
-- ============================================================
select
  p.role,
  p.code,
  p.name,
  case when p.boss_id is null then 'unclaimed' else 'has boss' end as ownership,
  p.created_at,
  (select count(*) from public.tasks t
    where t.employee_id = p.id) as tasks,
  (select count(*) from public.worklogs w
    where w.employee_id = p.id) as worklogs
from public.profiles p
where
     p.code ilike 'testboss%'
  or p.code ilike 'teststaff%'
  or p.code ilike 'testother%'
  or p.code ilike 'uiboss%'
  or p.code ilike 'uistaff%'
  or p.code ilike 'auto%'
  or p.code ilike 'diag%'
  or p.code ilike 'probe%'
  or p.code ilike 'ae%'
  or p.code ilike 'mb%'
  or p.code ilike 'sa%'
  or p.code ilike 'sb%'
order by p.role, p.created_at;

-- ============================================================
--  STEP 2 -- delete (run this only after reading step 1)
-- ============================================================
-- Uncomment the block below, add anything you want to keep to the
-- KEEP list, then run it.
--
-- Note on cascades: profiles.boss_id and tasks.boss_id reference
-- profiles(id) on delete cascade, and profiles.id references
-- auth.users on delete cascade -- i.e. the cascade points the
-- other way. So deleting a profile does NOT delete the auth.users
-- row; and deleting a profile that owns tasks WOULD delete those
-- tasks (via tasks.boss_id). Deleting from auth.users first is
-- therefore both sufficient and the safe order: it cascades to
-- profiles, which cascades to that person's tasks, logs and
-- worklogs.
--
-- do $clean$
-- declare
--   keep text[] := array[
--     'testboss001'        -- your usable boss account: NOT deleted
--   ];
--   victim record;
--   removed integer := 0;
-- begin
--   for victim in
--     select u.id, p.code, p.role
--       from auth.users u
--       join public.profiles p on p.id = u.id
--      where p.code <> all(keep)
--        and (
--             p.code ilike 'testboss%'
--          or p.code ilike 'teststaff%'
--          or p.code ilike 'testother%'
--          or p.code ilike 'uiboss%'
--          or p.code ilike 'uistaff%'
--          or p.code ilike 'auto%'
--          or p.code ilike 'diag%'
--          or p.code ilike 'probe%'
--          or p.code ilike 'ae%'
--          or p.code ilike 'mb%'
--          or p.code ilike 'sa%'
--          or p.code ilike 'sb%'
--        )
--   loop
--     delete from auth.users where id = victim.id;
--     removed := removed + 1;
--     raise notice 'deleted % (%)', victim.code, victim.role;
--   end loop;
--   raise notice 'total removed: %', removed;
-- end;
-- $clean$;

-- ============================================================
--  STEP 3 -- orphan employees
-- ============================================================
-- Accounts created before create_staff_account started setting
-- boss_id are unclaimed. They are invisible in the app (the
-- isolation policies hide them), so they are harmless, but they
-- can be removed:
--
--   select p.code, p.name, p.created_at
--     from public.profiles p
--    where p.role = 'employee' and p.boss_id is null
--    order by p.created_at;
--
--   delete from auth.users
--    where id in (select id from public.profiles
--                  where role = 'employee' and boss_id is null);
--
-- Add "and p.code not in ('...')" if any of them are real staff.

-- ============================================================
--  After running either block, confirm with:
--
--    select count(*) from public.profiles;
--    select p.role, p.code, p.name from public.profiles p
--     order by p.role, p.code;
-- ============================================================
