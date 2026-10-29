-- ============================================================
--  Project Recorder - database setup (run once)
--
--  ASCII-only on purpose. Earlier SQL files in this project had
--  Chinese comments and got re-encoded in transit; a full-width
--  dollar sign then broke a function body delimiter and produced
--  a misleading "syntax error at or near ^" from PostgreSQL.
--  Keeping SQL files ASCII removes that whole class of failure.
--
--  Run this whole file in Supabase -> SQL Editor -> Run.
--  Then run sql/create-staff-rpc.sql as a second query.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ============================================================
--  1. Tables
-- ============================================================

-- Account profiles. Login is "code + password", not real email.
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  code text unique not null,               -- login name: boss phone / staff code
  name text not null,
  role text not null default 'employee',   -- boss / employee
  boss_id uuid references profiles(id),    -- which boss this staff belongs to
  weekly_hours numeric default 40,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Tasks. Only the boss creates them, assigned to one employee.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  boss_id uuid not null references profiles(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  detail text default '',
  plan_date date not null,
  est_hours numeric default 0,             -- fallback when no timer was started
  project_name text default '',
  step_name text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()     -- required: the client sends it
);

-- Check-off records. An employee can only write their own.
create table if not exists task_logs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  finish_date date not null default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- One record per task per day: repeated submissions are ignored
  unique (task_id, finish_date)
);

-- Worklogs. Generated from check-offs; the boss side reads this table.
create table if not exists worklogs (
  id uuid primary key default gen_random_uuid(),
  boss_id uuid not null references profiles(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  work_date date not null,
  hours numeric not null,
  content text default '',
  project_name text default '',
  source text default 'task',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Columns added after the first release. "if not exists" keeps this
-- file safe to re-run on a database that already has them.
alter table profiles  add column if not exists updated_at timestamptz default now();
alter table tasks     add column if not exists updated_at timestamptz default now();
alter table task_logs add column if not exists updated_at timestamptz default now();
alter table worklogs  add column if not exists updated_at timestamptz default now();

-- ============================================================
--  2. Keep updated_at accurate
-- ============================================================
-- The client writes this column, so a missing column makes every
-- upsert fail with PGRST204 and the error is easy to miss.
-- A trigger keeps it correct without each write path remembering.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $touch$
begin
  new.updated_at = now();
  return new;
end;
$touch$;

drop trigger if exists trg_profiles_touch on profiles;
create trigger trg_profiles_touch before update on profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_tasks_touch on tasks;
create trigger trg_tasks_touch before update on tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_task_logs_touch on task_logs;
create trigger trg_task_logs_touch before update on task_logs
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_worklogs_touch on worklogs;
create trigger trg_worklogs_touch before update on worklogs
  for each row execute function public.touch_updated_at();

-- ============================================================
--  3. Auto-create the profiles row on sign-up
-- ============================================================
-- Whether an account is created by the app or through the dashboard
-- admin API, auth.users gets a row but profiles does not. Since
-- tasks.employee_id references profiles(id), a missing row makes
-- task assignment fail outright.
--
-- The role is derived from the internal email domain:
--     <code>@boss.pr   -> boss
--     <code>@staff.pr  -> employee
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $newuser$
declare
  local_part text;
  domain_part text;
begin
  local_part  := split_part(new.email, '@', 1);
  domain_part := split_part(new.email, '@', 2);

  insert into public.profiles (id, code, name, role)
  values (
    new.id,
    local_part,
    coalesce(new.raw_user_meta_data->>'name', local_part),
    case when domain_part = 'boss.pr' then 'boss' else 'employee' end
  )
  on conflict (id) do nothing;

  return new;
end;
$newuser$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: the trigger only affects accounts created after this runs.
insert into public.profiles (id, code, name, role)
select
  u.id,
  split_part(u.email, '@', 1),
  split_part(u.email, '@', 1),
  case when split_part(u.email, '@', 2) = 'boss.pr'
       then 'boss' else 'employee' end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ============================================================
--  4. Row level security
-- ============================================================
-- The anon key ships inside the apk, which is safe because access
-- is constrained by these policies.
alter table profiles  enable row level security;
alter table tasks     enable row level security;
alter table task_logs enable row level security;
alter table worklogs  enable row level security;

-- profiles: read your own row, and (if you are a boss) the rows of
-- your own staff.
--
-- An earlier version also allowed "boss_id is null", so that a boss
-- could find an unclaimed employee before claiming them. That was
-- an isolation hole: EVERY boss could see every unclaimed account,
-- and (via the update policy below) could claim it. Found by
-- e2e-multiboss.js, which showed two bosses each seeing all 14
-- staff accounts instead of only their own.
--
-- Accounts are now created already belonging to their boss, so no
-- "claim" step exists and the null case is gone.
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select
  using (
    id = auth.uid()
    or boss_id = auth.uid()
  );

-- profiles: the boss updates their own staff.
--   using      -> which rows may be updated
--   with check -> what they may become
-- Both are required. With only "using", the row would have to match
-- the condition *after* the update too.
drop policy if exists "boss updates staff" on profiles;
create policy "boss updates staff" on profiles for update
  using (boss_id = auth.uid())
  with check (boss_id = auth.uid());

-- profiles: allow inserting your own row (a safety net in case the
-- trigger above is missing).
drop policy if exists "insert own profile" on profiles;
create policy "insert own profile" on profiles for insert
  with check (id = auth.uid());

-- tasks: the boss owns theirs; an employee only reads their own.
drop policy if exists "boss manages tasks" on tasks;
create policy "boss manages tasks" on tasks for all
  using (boss_id = auth.uid()) with check (boss_id = auth.uid());

drop policy if exists "employee reads own tasks" on tasks;
create policy "employee reads own tasks" on tasks for select
  using (employee_id = auth.uid());

-- task_logs: employees write and delete their own; the boss reads
-- the logs belonging to their own tasks.
drop policy if exists "employee writes own logs" on task_logs;
create policy "employee writes own logs" on task_logs for insert
  with check (employee_id = auth.uid());

drop policy if exists "read own logs" on task_logs;
create policy "read own logs" on task_logs for select
  using (employee_id = auth.uid()
         or exists (select 1 from tasks t
                    where t.id = task_logs.task_id and t.boss_id = auth.uid()));

drop policy if exists "employee deletes own logs" on task_logs;
create policy "employee deletes own logs" on task_logs for delete
  using (employee_id = auth.uid());

-- worklogs: the boss reads their own; employees read and write theirs.
drop policy if exists "read own worklogs" on worklogs;
create policy "read own worklogs" on worklogs for select
  using (boss_id = auth.uid() or employee_id = auth.uid());

drop policy if exists "insert worklogs" on worklogs;
create policy "insert worklogs" on worklogs for insert
  with check (boss_id = auth.uid() or employee_id = auth.uid());

drop policy if exists "delete own worklogs" on worklogs;
create policy "delete own worklogs" on worklogs for delete
  using (employee_id = auth.uid());

-- ============================================================
--  5. Indexes
-- ============================================================
create index if not exists idx_tasks_employee_date
  on tasks (employee_id, plan_date);
create index if not exists idx_worklogs_boss_date
  on worklogs (boss_id, work_date);
create index if not exists idx_task_logs_employee
  on task_logs (employee_id, finish_date);

-- ============================================================
--  Done. Next: run sql/create-staff-rpc.sql
-- ============================================================
