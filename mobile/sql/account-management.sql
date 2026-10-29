-- ============================================================
--  Account management: things the client cannot do.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## Why these need server-side functions
--
--  Supabase email/password auth deliberately blocks three things
--  from the client:
--
--    1. CHANGING THE EMAIL. updateUser({email}) sends a
--       confirmation link to the NEW address. Our addresses are
--       fake (<code>@boss.pr), so the link is never clicked and
--       the change silently never happens.
--
--    2. DELETING AN ACCOUNT. The anon key can delete rows its RLS
--       policies allow, but auth.users is not exposed, so the
--       account itself cannot be removed.
--
--    3. RESETTING SOMEONE ELSE'S PASSWORD. Only the account owner
--       can do that (updateUser changes "the current user").
--
--  A SECURITY DEFINER function runs as the database owner, so it
--  can do all three -- while the caller still has to prove who
--  they are, checked inside each function.
--
--  ## What each function checks
--
--    rename_my_login      caller renames THEMSELVES only
--    delete_my_account    caller deletes THEMSELVES only
--    reset_staff_password caller must be the BOSS OF that employee
--
--  Running this file twice is harmless.
-- ============================================================


-- ############################################################
--  PART 1 -- rename my own login  (change the phone / staff code)
-- ############################################################
create or replace function public.rename_my_login(p_new_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $rename$
declare
  v_me uuid := auth.uid();
  v_code text;
  v_role text;
  v_domain text;
  v_old_email text;
  v_new_email text;
  v_taken uuid;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;

  v_code := lower(trim(coalesce(p_new_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  select role into v_role from public.profiles where id = v_me;
  if v_role is null then
    raise exception 'no profile for this account';
  end if;

  v_domain := case when v_role = 'boss' then '@boss.pr' else '@staff.pr' end;
  v_new_email := v_code || v_domain;

  select email into v_old_email from auth.users where id = v_me;
  if v_old_email = v_new_email then
    return jsonb_build_object('ok', true, 'code', v_code, 'unchanged', true);
  end if;

  -- ##########################################################
  -- COLLISION CHECK -- must look at BOTH domains.
  --
  -- The unique index is on auth.users.email, so it only catches
  -- a clash inside the same domain. But a boss's address is
  -- <code>@boss.pr and an employee's is <code>@staff.pr, so
  -- "renamed" as a boss and "renamed" as an employee are two
  -- different emails -- and the index lets both exist.
  --
  -- That produced a real bug: an employee renamed themselves to
  -- the boss's own login name and the function returned ok,true.
  -- Two accounts sharing a name means the worklog list shows two
  -- different people under one name.
  --
  -- So check both domains explicitly, and ignore my own row.
  -- ##########################################################
  select id into v_taken
    from auth.users
   where email in (v_code || '@boss.pr', v_code || '@staff.pr')
     and id <> v_me
   limit 1;
  if v_taken is not null then
    raise exception 'that login name is already taken on this server';
  end if;

  update auth.users
     set email = v_new_email,
         email_confirmed_at = now(),
         updated_at = now()
   where id = v_me;

  /* The identity row carries a copy of the email; leaving it stale
     makes some GoTrue versions refuse to sign in. */
  update auth.identities
     set identity_data = jsonb_build_object(
           'sub', v_me::text, 'email', v_new_email),
         provider_id = v_me::text,
         updated_at = now()
   where user_id = v_me;

  update public.profiles
     set code = v_code, email = v_new_email, updated_at = now()
   where id = v_me;

  return jsonb_build_object('ok', true, 'code', v_code,
                            'old_code', split_part(v_old_email, '@', 1));
end;
$rename$;

revoke all on function public.rename_my_login(text) from public;
revoke all on function public.rename_my_login(text) from anon;
grant execute on function public.rename_my_login(text) to authenticated;


-- ############################################################
--  PART 2 -- delete my own account
-- ############################################################
-- Deleting the auth.users row cascades to profiles, which cascades
-- to that account's tasks, task_logs and worklogs.
--
-- A boss's row also cascades to their staff's profiles, so the
-- whole team's data goes with them. That is mentioned in the app's
-- confirmation dialog.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $del$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;

  select role into v_role from public.profiles where id = v_me;

  delete from auth.users where id = v_me;

  return jsonb_build_object('ok', true, 'role', v_role);
end;
$del$;

revoke all on function public.delete_my_account() from public;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;


-- ############################################################
--  PART 3 -- boss resets an employee's password
-- ############################################################
-- The employee forgot it, or the boss forgot what they set.
-- Previously the only fix was the Supabase dashboard.
--
-- Scope check: the caller must be the boss that employee belongs
-- to. So "who can I reset" is exactly "who can I see".
create or replace function public.reset_staff_password(
  p_employee_id uuid,
  p_new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $reset$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = v_me and role = 'boss'
  ) then
    raise exception 'only a boss can reset a staff password';
  end if;

  if length(coalesce(p_new_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  select boss_id into v_owner
    from public.profiles
   where id = p_employee_id and role = 'employee';

  if v_owner is null then
    raise exception 'that account is not a staff member of yours';
  end if;
  if v_owner <> v_me then
    raise exception 'that staff member belongs to another boss';
  end if;

  update auth.users
     set encrypted_password = crypt(p_new_password, gen_salt('bf')),
         updated_at = now()
   where id = p_employee_id;

  return jsonb_build_object('ok', true, 'id', p_employee_id);
end;
$reset$;

revoke all on function public.reset_staff_password(uuid, text) from public;
revoke all on function public.reset_staff_password(uuid, text) from anon;
grant execute on function public.reset_staff_password(uuid, text)
  to authenticated;


-- ############################################################
--  PART 4 -- clean up leftover half-accounts
-- ############################################################
-- Accounts whose profiles row is gone (for example one deleted
-- through an older client) still hold their login name in
-- auth.users, so nobody can use it. This lets a boss free such a
-- name if it matches one of their own staff codes.
--
-- Run it as a plain query when needed:
--
--   select public.reclaim_orphan_login('A001');
--
-- It only touches an auth row that has NO profiles row, so it can
-- never remove a real account.
create or replace function public.reclaim_orphan_login(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $orphan$
declare
  v_me uuid := auth.uid();
  v_code text;
  v_email text;
  v_uid uuid;
  v_has_profile boolean;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;
  if not exists (select 1 from public.profiles
                  where id = v_me and role = 'boss') then
    raise exception 'only a boss can do this';
  end if;

  v_code := lower(trim(coalesce(p_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  /* Try both domains: the caller may want to free a staff name or
     a boss name. */
  foreach v_email in array array[v_code || '@staff.pr', v_code || '@boss.pr']
  loop
    select id into v_uid from auth.users where email = v_email;
    if v_uid is not null then
      select exists (select 1 from public.profiles where id = v_uid)
        into v_has_profile;
      if not v_has_profile then
        delete from auth.users where id = v_uid;
        return jsonb_build_object('ok', true, 'freed', v_email);
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'freed', null,
                            'note', 'no orphan account with that name');
end;
$orphan$;

revoke all on function public.reclaim_orphan_login(text) from public;
revoke all on function public.reclaim_orphan_login(text) from anon;
grant execute on function public.reclaim_orphan_login(text)
  to authenticated;


-- ############################################################
--  Verify
-- ############################################################
--
--   select proname, prosecdef from pg_proc
--    where proname in ('rename_my_login', 'delete_my_account',
--                      'reset_staff_password', 'reclaim_orphan_login');
--   -- all four should show prosecdef = true
--
-- Then in the app:
