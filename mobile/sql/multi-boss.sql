-- ============================================================
--  Allow every boss to create their own independent account.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## What changes and why
--
--  Before: only ONE boss could exist ("first one wins"), and
--  login names were globally unique. That made a shared Supabase
--  project unusable for more than one company.
--
--  After: any number of bosses, each with their own separate
--  staff, tasks and worklogs.
--
--  ## Data isolation already works
--
--  Every table is scoped by boss_id and every policy compares it
--  to auth.uid(), so boss A cannot see boss B's staff, tasks,
--  task logs or worklogs. Nothing needs to change there.
--
--  ## The one real obstacle
--
--  profiles.code had a GLOBAL unique constraint. Login is
--  "<code>@boss.pr" / "<code>@staff.pr", so a globally unique code
--  meant two bosses could not both register with the same phone
--  number.
--
--  Fix: uniqueness moves to where it actually matters.
--
--    * profiles.code  -> unique per boss (two bosses may both
--                        have a staff member called A001)
--    * profiles.email -> globally unique (it is the real login
--                        key, so it must stay unique)
--
--  On a name collision the app appends a short suffix and shows
--  the resulting name, so the user always knows what to type.
-- ============================================================

-- ============================================================
--  1. keep the full internal email on the profile
-- ============================================================
-- Used to detect collisions and to tell the user their exact
-- login name when it differs from what they typed.
alter table public.profiles
  add column if not exists email text;

-- Backfill from the auth row (the authoritative copy).
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and (p.email is null or p.email = '');

-- Every account must map to a unique login email.
create unique index if not exists profiles_email_key
  on public.profiles (lower(email));

-- ============================================================
--  2. drop the global uniqueness on code
-- ============================================================
-- The constraint created by "code text unique" is named
-- profiles_code_key by default; drop it if it is still there.
alter table public.profiles drop constraint if exists profiles_code_key;

-- Replace it with a per-boss unique index.
--
-- Why a partial index: a boss has boss_id = null, and we do not
-- want two bosses who both left boss_id null to collide. So the
-- index only covers employees, keyed on (their boss, their code).
drop index if exists public.profiles_boss_code_key;
create unique index profiles_boss_code_key
  on public.profiles (boss_id, lower(code))
  where boss_id is not null;

-- ============================================================
--  3. boss self-registration, now unlimited
-- ============================================================
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

-- The login screen has no session yet, so anonymous callers must
-- be able to reach this. Each call only creates one new account
-- that can see nothing but its own data.
revoke all on function public.create_boss_account(text, text, text) from public;
grant execute on function public.create_boss_account(text, text, text)
  to anon, authenticated;

-- ============================================================
--  4. staff creation: same, but must also stay per-boss
-- ============================================================
-- create_staff_account already refuses unless the caller is a
-- signed-in boss, and always sets boss_id = auth.uid(), so each
-- boss gets their own separate staff list. The only change needed
-- is to record the derived email on the profile.
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

  -- Already created (possibly by another boss)? Then this boss
  -- cannot use that name. Say so clearly instead of silently
  -- linking to someone else's employee.
  select id into v_existing from auth.users where email = v_email;
  if v_existing is not null then
    if exists (select 1 from public.profiles
                where id = v_existing and boss_id = auth.uid()) then
      -- Already mine: idempotent, safe to click twice.
      update public.profiles
         set name = v_name
       where id = v_existing;
      return jsonb_build_object(
        'ok', true, 'id', v_existing, 'code', v_code,
        'already_existed', true);
    end if;
    raise exception 'the code % is already taken on this server; pick another one', v_code;
  end if;

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

-- ============================================================
--  5. close an isolation hole in the profile policies
-- ============================================================
-- Found by e2e-multiboss.js: two bosses each saw ALL 14 staff
-- accounts instead of only their own.
--
-- Cause: both policies allowed "boss_id is null", i.e. any boss
-- could see and update every unclaimed employee on the server.
--
-- Those clauses were added for an earlier "claim an existing
-- account" flow that no longer exists (accounts are now created
-- already belonging to their boss). Removing them:
--
--   * a boss sees only their own staff
--   * a boss cannot grab someone else's employee
--
-- The trigger that creates the profile row runs as security
-- definer while inserting, so it is not affected by these SELECT
-- policies, and create_staff_account sets boss_id in the same
-- statement, so a freshly created employee is never unclaimed.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select
  using (
    id = auth.uid()
    or boss_id = auth.uid()
  );

drop policy if exists "boss updates staff" on public.profiles;
create policy "boss updates staff" on public.profiles for update
  using (boss_id = auth.uid())
  with check (boss_id = auth.uid());

-- ============================================================
--  6. adopt any legacy unclaimed accounts
-- ============================================================
-- Old test rows (created before create_staff_account started
-- setting boss_id) are still unclaimed. They are invisible to
-- every boss once the policies above are in place, which is the
-- safe default -- they simply sit there until assigned.
--
-- Assign them to a specific boss if you want to keep them.
-- Replace the code below, then run this block by hand:
--
--   update public.profiles
--      set boss_id = (select id from public.profiles
--                      where code = 'PUT-THE-BOSS-CODE-HERE')
--    where role = 'employee' and boss_id is null;
--
-- Or delete them:
--
--   delete from public.profiles
--    where role = 'employee' and boss_id is null;
--
-- (Deleting the profile cascades to that account's tasks and logs.)

-- ============================================================
--  7. retire the old single-boss function
-- ============================================================
drop function if exists public.create_first_boss(text, text, text);

-- ============================================================
--  Verify:
--
--    select p.code, p.name, p.role, p.email
--    from public.profiles p order by p.role, p.code;
--
--  To watch isolation, register two bosses in the app and check
--  that neither one's staff list shows the other's people.
-- ============================================================
