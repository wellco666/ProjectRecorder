-- Check that the phone's employee really has profiles.id == auth.users.id.
--
-- RLS on tasks is `employee_id = auth.uid()`. If profiles.id and the
-- auth user id differ for this account, the employee sees zero tasks
-- and the sync cursor never advances -- which matches the symptom
-- exactly (cursor stuck at 2026-10-15 while sync keeps succeeding).
select p.id as profile_id,
       p.code,
       p.name,
       p.role,
       p.boss_id,
       (select count(*) from auth.users u where u.id = p.id) as auth_rows
  from public.profiles p
 where p.id = 'fd097678-7e76-4450-a565-9e0dffd809f9';

-- How many tasks does that employee actually have?
select count(*) as task_count
  from public.tasks
 where employee_id = 'fd097678-7e76-4450-a565-9e0dffd809f9';
