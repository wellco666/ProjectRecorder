-- ============================================================
--  One-shot migration for the notification feature.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## What this does
--
--  Two independent things, combined so there is one file to run:
--
--    A. task_events  -- the notification feed. Records what
--       happened (assigned / done / undone) so the other side can
--       be told about it.
--
--    B. staff code reclaiming -- a code held by an ORPHAN account
--       (no boss) can be taken over instead of being refused
--       forever. A code owned by another boss is still refused.
--
--  Running this twice is harmless.
-- ============================================================


-- ############################################################
--  PART A -- notification feed
-- ############################################################

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  boss_id uuid not null references public.profiles(id) on delete cascade,
  employee_id uuid references public.profiles(id) on delete cascade,
  kind text not null,                    -- assigned / done / undone
  title text default '',
  hours numeric,
  work_date date,
  created_at timestamptz default now()
);

-- Catch typos like kind='complete' when writing, instead of
-- producing events the app cannot phrase.
do $kindcheck$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'task_events_kind_check'
  ) then
    alter table public.task_events
      add constraint task_events_kind_check
      check (kind in ('assigned', 'done', 'undone'));
  end if;
end;
$kindcheck$;

create index if not exists idx_task_events_boss
  on public.task_events (boss_id, created_at);
create index if not exists idx_task_events_employee
  on public.task_events (employee_id, created_at);

alter table public.task_events enable row level security;

drop policy if exists "read own task events" on public.task_events;
create policy "read own task events" on public.task_events for select
  using (boss_id = auth.uid() or employee_id = auth.uid());

drop policy if exists "insert task events" on public.task_events;
create policy "insert task events" on public.task_events for insert
  with check (boss_id = auth.uid() or employee_id = auth.uid());

-- Creating a task automatically records "assigned".
--
-- A trigger rather than client code, so EVERY creation path
-- produces the event: the app, a script, or a manual insert in the
-- dashboard. Client-side insertion would be one more thing to
-- forget when a new path is added.
create or replace function public.log_task_assigned()
returns trigger
language plpgsql
security definer set search_path = public
as $assigned$
begin
  insert into public.task_events
    (task_id, boss_id, employee_id, kind, title, hours)
  values
    (new.id, new.boss_id, new.employee_id, 'assigned',
     new.title, new.est_hours);
  return new;
end;
$assigned$;

drop trigger if exists trg_task_assigned on public.tasks;
create trigger trg_task_assigned
  after insert on public.tasks
  for each row execute function public.log_task_assigned();

-- Backfill so tasks that already exist also produce a notification
-- on the employee's next sync.
insert into public.task_events
  (task_id, boss_id, employee_id, kind, title, hours, created_at)
select t.id, t.boss_id, t.employee_id, 'assigned', t.title,
       t.est_hours, t.created_at
from public.tasks t
where not exists (
  select 1 from public.task_events e
   where e.task_id = t.id and e.kind = 'assigned'
);

-- "done" and "undone" are written by the app, which already writes
-- task_logs and worklogs on check-off and deletes them on undo.
-- A trigger could cover "done", but "undone" has no row to hang a
-- trigger on, so both go through the client for symmetry.


-- ############################################################
--  PART B -- let a boss reclaim an orphaned staff code
-- ############################################################
--
-- Problem: create_staff_account refused any code that already
-- existed. That is right for a code owned by ANOTHER boss, but
-- wrong for an orphan -- an account whose boss was deleted, or one
-- left behind by a test run. Those rows have boss_id = null, are
-- invisible to every boss, and yet their code could never be used
-- again by anyone.
--
--   code taken by another boss  -> still refused
--   code held by an orphan      -> adopted (owner set, password
--                                  reset, profile renamed)
--
-- Adopting is safe: an orphan has no owner to displace.

create or replace function public.create_staff_account(
  p_code text,
  p_password text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $staff$
declare
  v_uid uuid;
  v_email text;
  v_code text;
  v_name text;
  v_existing uuid;
  v_existing_boss uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'boss'
  ) then
    raise exception 'only a boss can create staff accounts';
  end if;

  v_code := lower(trim(coalesce(p_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  if length(coalesce(p_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_code);
  v_email := v_code || '@staff.pr';

  select id into v_existing from auth.users where email = v_email;

  if v_existing is not null then
    select boss_id into v_existing_boss
      from public.profiles where id = v_existing;

    -- 1. already mine -> idempotent, safe to click twice
    if v_existing_boss = auth.uid() then
      update public.profiles set name = v_name where id = v_existing;
      return jsonb_build_object(
        'ok', true, 'id', v_existing, 'code', v_code,
        'already_existed', true);
    end if;

    -- 2. someone else's -> refuse, do not steal their staff
    if v_existing_boss is not null then
      raise exception 'the code % belongs to another boss on this server; pick another one', v_code;
    end if;

    -- 3. orphan -> adopt it
    update auth.users
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = now(),
           updated_at = now()
     where id = v_existing;

    update public.profiles
       set boss_id = auth.uid(),
           name = v_name,
           code = v_code,
           role = 'employee',
           email = v_email,
           updated_at = now()
     where id = v_existing;

    return jsonb_build_object(
      'ok', true, 'id', v_existing, 'code', v_code, 'adopted', true);
  end if;

  -- create a fresh account
  v_uid := gen_random_uuid();

  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_uid, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', v_name),
    now(), now(), '', '', '', ''
  );

  insert into auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at, id
  ) values (
    v_uid::text, v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email),
    'email', now(), now(), now(), gen_random_uuid()
  );

  insert into public.profiles (id, code, name, role, email, boss_id)
  values (v_uid, v_code, v_name, 'employee', v_email, auth.uid())
  on conflict (id) do update
    set boss_id = auth.uid(), name = v_name, code = v_code, email = v_email;

  update public.profiles
     set name = v_name, boss_id = auth.uid(), email = v_email
   where id = v_uid;

  return jsonb_build_object(
    'ok', true, 'id', v_uid, 'code', v_code, 'already_existed', false);
end;
$staff$;

revoke all on function public.create_staff_account(text, text, text) from public;
revoke all on function public.create_staff_account(text, text, text) from anon;
grant execute on function public.create_staff_account(text, text, text)
  to authenticated;


-- ############################################################
--  Verify
-- ############################################################
--
--   select proname, prosecdef from pg_proc
--    where proname in ('create_staff_account', 'log_task_assigned');
--
--   select count(*) from public.task_events;
--
--   select count(*) from public.profiles
--    where role = 'employee' and boss_id is null;   -- orphans left
--
-- Then run the app: assign a task and confirm one 'assigned' row
-- appears, and create a staff account with a previously failing
-- code and confirm it succeeds.


-- ############################################################
--  PART C -- boss self-registration (unlimited)
-- ############################################################
--
-- Each boss creates their own account on the login screen.
-- Data is isolated by RLS: every table is scoped by boss_id and
-- compared to auth.uid(), so two bosses cannot see each other's
-- staff, tasks or worklogs.
--
-- A name collision is NOT refused: a numeric suffix is appended
-- and the final name is returned, because the alternative is a
-- dead end for the person registering.

create or replace function public.create_boss_account(
  p_code text,
  p_password text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $boss$
declare
  v_uid uuid;
  v_code text;
  v_base text;
  v_email text;
  v_name text;
  v_suffix integer := 1;
begin
  ------------------------------------------------------------
  -- 1. validate input
  ------------------------------------------------------------
  v_base := lower(trim(coalesce(p_code, '')));
  if v_base !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  if length(coalesce(p_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_base);

  ------------------------------------------------------------
  -- 2. find a free login name.
  --
  -- Two bosses may want the same phone number. Rather than
  -- refusing, append a numeric suffix and report the final name
  -- back so the app can show exactly what to log in with.
  ------------------------------------------------------------
  v_code := v_base;
  v_email := v_code || '@boss.pr';
  while exists (select 1 from auth.users where email = v_email) loop
    v_suffix := v_suffix + 1;
    if v_suffix > 99 then
      raise exception 'too many accounts already use the name %', v_base;
    end if;
    v_code := v_base || '-' || v_suffix::text;
    v_email := v_code || '@boss.pr';
  end loop;

  ------------------------------------------------------------
  -- 3. create the account
  ------------------------------------------------------------
  v_uid := gen_random_uuid();

  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_uid, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', v_name),
    now(), now(), '', '', '', ''
  );

  insert into auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at, id
  ) values (
    v_uid::text, v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email),
    'email', now(), now(), now(), gen_random_uuid()
  );

  ------------------------------------------------------------
  -- 4. profile. boss_id stays null on purpose: a boss does not
  --    belong to another boss. Their staff point at them.
  ------------------------------------------------------------
  insert into public.profiles (id, code, name, role, email, boss_id)
  values (v_uid, v_code, v_name, 'boss', v_email, null)
  on conflict (id) do update
    set code = v_code, name = v_name, role = 'boss', email = v_email;

  update public.profiles
     set role = 'boss', name = v_name, code = v_code, email = v_email
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'id', v_uid,
    'code', v_code,                 -- the name to actually log in with
    'requested_code', v_base,       -- what the user typed
    'renamed', v_code <> v_base
  );
end;
$boss$;

-- The login screen has no session yet (nobody is signed in when the
-- first boss registers), so anonymous callers MUST be able to reach
-- this. Each call only creates one account that can see nothing but
-- its own data, so leaving it reachable is safe.
revoke all on function public.create_boss_account(text, text, text) from public;
grant execute on function public.create_boss_account(text, text, text)
  to anon, authenticated;

-- ============================================================
--  Verify everything in this file landed
-- ============================================================
--
--   select proname, prosecdef from pg_proc
--    where proname in ('create_staff_account', 'create_boss_account',
--                      'log_task_assigned');
--   -- all three should show prosecdef = true
--
--   select count(*) from public.task_events;
--   select count(*) from public.profiles;
--
-- Then in the app: register a boss, create a staff account, assign a
-- task, and check that a row appears in task_events.

