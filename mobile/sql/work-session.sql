-- ============================================================
--  Work sessions: the clock-in / clock-out button.
--
--  The loop this adds:
--      tap start -> the app shows a running timer -> tap stop
--      -> a worklog row + merit points, both written server side
--
--  Why a separate table instead of a flag on profiles:
--    * a person may clock in and out many times a day
--    * the boss's dashboard needs to know who is working RIGHT NOW
--      (an open session = ended_at is null), which is a query on
--      this table, not on a profile field
--
--  Only one open session per person: enforced with a partial unique
--  index, so a double tap (or two devices) cannot create two open
--  sessions and double-count the time.
--
--  The rate below (10 points per hour) must stay equal to
--  MERIT.hourRate in merit.js. A selfcheck compares the two.
--
--  This file is ASCII-only on purpose.
-- ============================================================

create table if not exists public.work_sessions (
  id          uuid primary key default gen_random_uuid(),
  boss_id     uuid not null references public.profiles(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  task_id     uuid references public.tasks(id) on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  hours       numeric,
  created_at  timestamptz not null default now()
);

-- one open session per person, enforced by the database
create unique index if not exists work_sessions_open_idx
  on public.work_sessions (profile_id)
  where ended_at is null;

create index if not exists work_sessions_boss_idx
  on public.work_sessions (boss_id, started_at desc);

alter table public.work_sessions enable row level security;

drop policy if exists "see own sessions" on public.work_sessions;
create policy "see own sessions" on public.work_sessions
  for select using (
    profile_id = auth.uid() or boss_id = auth.uid()
  );

-- writes go through the functions below only
revoke insert, update, delete on public.work_sessions from anon, authenticated;

-- ------------------------------------------------------------
--  start_work
-- ------------------------------------------------------------
create or replace function public.start_work(p_task uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_boss uuid;
  v_id uuid;
  v_started timestamptz;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select coalesce(boss_id, id) into v_boss
    from public.profiles where id = v_uid;

  if v_boss is null then
    raise exception 'no such profile';
  end if;

  if exists (
    select 1 from public.work_sessions
    where profile_id = v_uid and ended_at is null
  ) then
    raise exception 'already working';
  end if;

  insert into public.work_sessions (boss_id, profile_id, task_id)
  values (v_boss, v_uid, p_task)
  returning id, started_at into v_id, v_started;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'started_at', v_started
  );
end;
$fn$;

-- ------------------------------------------------------------
--  end_work
--
--  Writes both records in one call so they can never disagree:
--    * a worklog row (the boss's existing hours view picks it up)
--    * a merit row for the time worked
-- ------------------------------------------------------------
create or replace function public.end_work()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_row public.work_sessions%rowtype;
  v_hours numeric;
  v_merit integer;
  v_balance integer;
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select * into v_row
    from public.work_sessions
   where profile_id = v_uid and ended_at is null
   order by started_at desc
   limit 1;

  if not found then
    raise exception 'not working';
  end if;

  v_hours := round(
    extract(epoch from (now() - v_row.started_at)) / 3600.0, 2
  );

  -- Ignore accidental double taps. 20 seconds is the floor:
  --   under that it is a mis-tap, not work.
  --   over that we still record it, even if the merit rounds to 0.
  --
  -- An earlier 1-minute floor made a 40-second session vanish
  -- completely, which reads as "the timer is not recording".
  if v_hours < 0.005 then
    v_hours := 0;
  end if;

  update public.work_sessions
     set ended_at = now(), hours = v_hours
   where id = v_row.id;

  if v_hours > 0 then
    insert into public.worklogs (
      boss_id, employee_id, task_id, work_date, hours, content, source
    ) values (
      v_row.boss_id, v_uid, v_row.task_id, v_today, v_hours, '', 'timer'
    );

    v_merit := round(v_hours * 10);

    if v_merit <> 0 then
      insert into public.merit_ledger (
        boss_id, profile_id, amount, kind, reason, source_id
      ) values (
        v_row.boss_id, v_uid, v_merit, 'hours', '', v_row.id
      );
    end if;
  else
    v_merit := 0;
  end if;

  select coalesce(sum(amount), 0) into v_balance
    from public.merit_ledger where profile_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'hours', v_hours,
    'recorded', v_hours > 0,
    'merit', v_merit,
    'balance', v_balance
  );
end;
$fn$;

revoke all on function public.start_work(uuid) from public;
revoke all on function public.start_work(uuid) from anon;
grant execute on function public.start_work(uuid) to authenticated;

revoke all on function public.end_work() from public;
revoke all on function public.end_work() from anon;
grant execute on function public.end_work() to authenticated;

-- ============================================================
--  Verify:
--    select * from public.work_sessions order by started_at desc limit 5;
-- ============================================================
