-- ============================================================
--  Cap a work session at one day.
--
--  The problem
--  -----------
--  end_work computed hours as (now - started_at) with NO upper
--  bound. One forgotten clock-out is all it takes:
--
--      start Monday 09:00, forget, hit stop Thursday 09:00
--      -> 72 hours -> 720 points, out of nowhere.
--
--  Same thing happens when a stop fails offline: the session stays
--  open, the timer keeps running locally, and the next successful
--  stop pays out the whole gap.
--
--  Points are money in this app, so an unbounded input is not a
--  cosmetic bug.
--
--  What this does
--  --------------
--  1. end_work clamps hours to 24 (a day is a day).
--  2. start_work no longer refuses when a STALE session is open
--     (older than 24h). It closes that one first, capped, and
--     starts fresh. Otherwise a user who cannot stop (offline,
--     app wiped, forgotten) is locked out of starting at all -
--     "already working" forever.
--
--  This file is ASCII-only on purpose.
-- ============================================================

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
  v_capped boolean := false;
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

  -- A session can never be longer than a day.
  if v_hours > 24 then
    v_hours := 24;
    v_capped := true;
  end if;

  -- Ignore accidental double taps. 20 seconds is the floor.
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
    'capped', v_capped,
    'merit', v_merit,
    'balance', v_balance
  );
end;
$fn$;

create or replace function public.start_work(p_task uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_boss uuid;
  v_open public.work_sessions%rowtype;
  v_hours numeric;
  v_id uuid;
  v_started timestamptz;
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_closed_stale boolean := false;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select coalesce(boss_id, id) into v_boss
    from public.profiles where id = v_uid;

  if v_boss is null then
    raise exception 'no such profile';
  end if;

  select * into v_open
    from public.work_sessions
   where profile_id = v_uid and ended_at is null
   order by started_at desc
   limit 1;

  if found then
    v_hours := round(
      extract(epoch from (now() - v_open.started_at)) / 3600.0, 2
    );

    if v_hours <= 24 then
      raise exception 'already working';
    end if;

    /* Stale session: close it (capped) instead of locking the user
       out with "already working" forever. */
    v_hours := 24;

    update public.work_sessions
       set ended_at = now(), hours = v_hours
     where id = v_open.id;

    insert into public.worklogs (
      boss_id, employee_id, task_id, work_date, hours, content, source
    ) values (
      v_open.boss_id, v_uid, v_open.task_id, v_today, v_hours, '', 'timer'
    );

    insert into public.merit_ledger (
      boss_id, profile_id, amount, kind, reason, source_id
    ) values (
      v_open.boss_id, v_uid, round(v_hours * 10), 'hours', '', v_open.id
    );

    v_closed_stale := true;
  end if;

  insert into public.work_sessions (boss_id, profile_id, task_id)
  values (v_boss, v_uid, p_task)
  returning id, started_at into v_id, v_started;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'started_at', v_started,
    'closed_stale', v_closed_stale
  );
end;
$fn$;

revoke all on function public.end_work() from public;
revoke all on function public.start_work(uuid) from public;
revoke all on function public.end_work() from anon;
revoke all on function public.start_work(uuid) from anon;
grant execute on function public.end_work() to authenticated;
grant execute on function public.start_work(uuid) to authenticated;

-- ============================================================
--  Verify the cap with a deliberately stale session:
--
--    update public.work_sessions
--       set started_at = now() - interval '3 days'
--     where ended_at is null;
--    -- then end_work should return hours = 24, capped = true
-- ============================================================
