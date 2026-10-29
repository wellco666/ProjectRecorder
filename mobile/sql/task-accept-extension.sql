-- =============================================================
--  Task acceptance + extension requests
--
--  Run this whole file once in the SQL Editor. Safe to re-run
--  (everything is "if not exists" / "create or replace").
--
--  ## Why these two features use RPC instead of plain table writes
--
--  "Accept this task" and "ask for an extension" are writes started
--  by the employee, but the tasks table policy is:
--      boss    for all   (rows they own)
--      employee for select (only their own row)
--
--  Letting employees UPDATE tasks would also let them change the
--  title, the date, or who it is assigned to. Too wide.
--
--  So these go through SECURITY DEFINER functions that change only
--  the allowed columns and also verify "you really are the assignee".
--  create_staff_account already uses the same pattern.
--
--  ## Offline
--
--  Both actions must reach the other person to mean anything, so they
--  require a connection. Failures come back as clear errors and the UI
--  shows them; nothing fails silently.
-- =============================================================


-- ---------------------------------------------------------- 0. event kinds
--
-- task_events.kind has an allow-list (it was written to catch typos like
-- kind='complete'). The four new events must be added to it, otherwise
-- every insert below fails with 23514 check_violation -- and since the
-- functions run in a transaction, the whole action fails, not just the
-- notification.
--
-- worth noting: that allow-list is exactly what caught this during the
-- end-to-end test. Keeping it is worth the extra line here.

alter table public.task_events drop constraint if exists task_events_kind_check;
alter table public.task_events
  add constraint task_events_kind_check
  check (kind in ('assigned', 'done', 'undone',
                  'rejected', 'extend', 'extend_ok', 'extend_no'));


-- ---------------------------------------------------------- 1. tasks columns
--
-- accept_status is tri-state:
--   pending   just assigned, employee has not answered yet
--   accepted  employee took it
--   rejected  employee refused; accept_reason holds why

alter table public.tasks
  add column if not exists accept_status text not null default 'pending';

alter table public.tasks
  add column if not exists accept_reason text default '';

alter table public.tasks
  add column if not exists accept_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_accept_status_check'
  ) then
    alter table public.tasks
      add constraint tasks_accept_status_check
      check (accept_status in ('pending', 'accepted', 'rejected'));
  end if;
end $$;


-- ---------------------------------------------------------- 2. request table
--
-- One table for every "employee asks the boss for something".
-- Only kind='extension' exists today; adding other kinds later
-- needs no new table.

create table if not exists public.task_requests (
  id uuid primary key,
  boss_id uuid not null references public.profiles(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null default 'extension',
  reason text not null default '',
  to_date date,
  status text not null default 'pending',
  decision_note text default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'task_requests_status_check'
  ) then
    alter table public.task_requests
      add constraint task_requests_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists idx_task_requests_task
  on public.task_requests(task_id, created_at desc);
create index if not exists idx_task_requests_boss
  on public.task_requests(boss_id, status);
create index if not exists idx_task_requests_employee
  on public.task_requests(employee_id, status);

alter table public.task_requests enable row level security;

drop policy if exists "read own task requests" on public.task_requests;
create policy "read own task requests" on public.task_requests
  for select to authenticated
  using (boss_id = auth.uid() or employee_id = auth.uid());

-- Writes go exclusively through the functions below, so only SELECT is
-- granted here. No insert/update policy means a direct client write is
-- rejected -- intentionally: the state machine must run inside a function
-- so identity is checked, an event is recorded, and the task date moves.

grant select on public.task_requests to authenticated;


-- ---------------------------------------------------------- 3. accept / reject
--
-- Refusing requires a reason. An empty reason raises, so a stray tap
-- cannot silently drop a task back on the boss.

create or replace function public.accept_task(
  p_task_id uuid,
  p_accept boolean,
  p_reason text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  t public.tasks;
  why text := btrim(coalesce(p_reason, ''));
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select * into t from public.tasks where id = p_task_id;
  if not found then
    raise exception 'task not found';
  end if;
  if t.employee_id <> me then
    raise exception 'only the assignee can accept this task';
  end if;

  if p_accept then
    update public.tasks
       set accept_status = 'accepted',
           accept_reason = '',
           accept_at = now(),
           updated_at = now()
     where id = p_task_id;
    return jsonb_build_object('ok', true, 'status', 'accepted');
  end if;

  if why = '' then
    raise exception 'reason required';
  end if;

  update public.tasks
     set accept_status = 'rejected',
         accept_reason = why,
         accept_at = now(),
         updated_at = now()
   where id = p_task_id;

  -- Notify the boss. SECURITY DEFINER means this insert is not limited
  -- by the task_events RLS policy.
  insert into public.task_events (id, boss_id, employee_id, task_id, kind, title)
  values (gen_random_uuid(), t.boss_id, t.employee_id, t.id, 'rejected', t.title);

  return jsonb_build_object('ok', true, 'status', 'rejected');
end $$;


-- ---------------------------------------------------------- 4. extension request
--
-- Only one pending extension per task. Otherwise five taps produce five
-- identical requests on the boss side.

create or replace function public.request_task_extension(
  p_task_id uuid,
  p_to_date date,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  t public.tasks;
  why text := btrim(coalesce(p_reason, ''));
  req_id uuid;
  existing uuid;
begin
  if me is null then
    raise exception 'not signed in';
  end if;
  if why = '' then
    raise exception 'reason required';
  end if;
  if p_to_date is null then
    raise exception 'new date required';
  end if;

  select * into t from public.tasks where id = p_task_id;
  if not found then
    raise exception 'task not found';
  end if;
  if t.employee_id <> me then
    raise exception 'only the assignee can request an extension';
  end if;
  if p_to_date <= t.plan_date then
    raise exception 'new date must be later than the planned date';
  end if;

  select id into existing
    from public.task_requests
   where task_id = p_task_id and kind = 'extension' and status = 'pending'
   limit 1;

  if existing is not null then
    -- Already pending: update it rather than piling up another row.
    update public.task_requests
       set to_date = p_to_date,
           reason = why,
           created_at = now()
     where id = existing;
    return jsonb_build_object('ok', true, 'request_id', existing, 'updated', true);
  end if;

  req_id := gen_random_uuid();
  insert into public.task_requests
    (id, boss_id, employee_id, task_id, kind, reason, to_date, status)
  values
    (req_id, t.boss_id, t.employee_id, t.id, 'extension', why, p_to_date, 'pending');

  insert into public.task_events (id, boss_id, employee_id, task_id, kind, title, work_date)
  values (gen_random_uuid(), t.boss_id, t.employee_id, t.id, 'extend', t.title, p_to_date);

  return jsonb_build_object('ok', true, 'request_id', req_id, 'updated', false);
end $$;


-- ---------------------------------------------------------- 5. approve / reject
--
-- Approve -> move the task to the new date and tell the employee.
-- Reject  -> date unchanged, tell the employee, include the boss note.

create or replace function public.decide_task_extension(
  p_request_id uuid,
  p_approved boolean,
  p_note text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  r public.task_requests;
  t public.tasks;
  note text := btrim(coalesce(p_note, ''));
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select * into r from public.task_requests where id = p_request_id;
  if not found then
    raise exception 'request not found';
  end if;
  if r.boss_id <> me then
    raise exception 'only the boss can decide this request';
  end if;
  if r.status <> 'pending' then
    raise exception 'request already decided';
  end if;

  select * into t from public.tasks where id = r.task_id;
  if not found then
    raise exception 'task not found';
  end if;

  update public.task_requests
     set status = case when p_approved then 'approved' else 'rejected' end,
         decision_note = note,
         decided_at = now()
   where id = p_request_id;

  if p_approved then
    update public.tasks
       set plan_date = r.to_date,
           updated_at = now()
     where id = r.task_id;

    insert into public.task_events (id, boss_id, employee_id, task_id, kind, title, work_date)
    values (gen_random_uuid(), t.boss_id, t.employee_id, t.id,
            'extend_ok', t.title, r.to_date);
  else
    insert into public.task_events (id, boss_id, employee_id, task_id, kind, title)
    values (gen_random_uuid(), t.boss_id, t.employee_id, t.id,
            'extend_no', t.title);
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case when p_approved then 'approved' else 'rejected' end,
    'task_id', r.task_id,
    'to_date', r.to_date);
end $$;


grant execute on function public.accept_task(uuid, boolean, text) to authenticated;
grant execute on function public.request_task_extension(uuid, date, text) to authenticated;
grant execute on function public.decide_task_extension(uuid, boolean, text) to authenticated;
