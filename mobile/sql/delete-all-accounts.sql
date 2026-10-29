-- ============================================================
--  Delete every test account.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  Step 1 lists what will be removed. Step 2 removes it.
--  Run the whole file in one go; the listing appears in the
--  output as NOTICE lines before the delete happens.
--
--  WARNING: this removes EVERY boss account, including the one
--  you can currently log in with. After running it, open the app
--  and use "create a boss account" on the login screen to make
--  a fresh one.
-- ============================================================

-- ============================================================
--  STEP 1 -- list (read only)
-- ============================================================
select
  p.role,
  p.code,
  p.name,
  case when p.boss_id is null then 'unclaimed' else 'has boss' end
    as ownership,
  p.created_at,
  (select count(*) from public.tasks t
    where t.employee_id = p.id) as tasks,
  (select count(*) from public.worklogs w
    where w.employee_id = p.id) as worklogs
from public.profiles p
order by p.role, p.created_at;

-- ============================================================
--  STEP 2 -- delete everything
-- ============================================================
-- Deleting the auth.users row is enough: it cascades to
-- profiles, which cascades to that person's tasks, task_logs
-- and worklogs.
do $clean$
declare
  victim record;
  removed integer := 0;
begin
  for victim in
    select u.id, p.code, p.role
      from auth.users u
      join public.profiles p on p.id = u.id
     order by p.role, p.created_at
  loop
    raise notice 'deleting % (%)', victim.code, victim.role;
    delete from auth.users where id = victim.id;
    removed := removed + 1;
  end loop;
  raise notice '--- total removed: % ---', removed;
end;
$clean$;

-- ============================================================
--  STEP 3 -- confirm it is empty
-- ============================================================
select count(*) as remaining_profiles from public.profiles;
select count(*) as remaining_auth_users from auth.users;
