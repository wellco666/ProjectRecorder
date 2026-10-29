-- ============================================================
--  Let the boss create staff accounts directly from the app.
--
--  NOTE: this file is deliberately ASCII-only.
--  Earlier versions had Chinese comments, and the file got
--  re-encoded somewhere along the way; a full-width dollar sign
--  (U+FF04) appeared inside a comment and broke the $$...$$
--  function body delimiter, producing a confusing
--  "syntax error at or near ^" from PostgreSQL.
--  Keeping it ASCII removes that whole class of failure.
-- ============================================================
--
--  Why this function is needed:
--
--  Supabase's client API cannot create other users:
--    * auth.signUp() switches the current session to the new
--      account, so the boss gets logged out.
--    * The admin API needs the service_role key, which must never
--      ship inside an apk (it bypasses every RLS policy).
--
--  A SECURITY DEFINER function solves it: it runs as the database
--  owner so it can write auth.users, but the caller must first pass
--  the role check below. The service_role key stays inside the
--  database and never reaches the client.
--
--  Security checklist:
--    1. security definer      - run as owner to write auth.users
--    2. set search_path       - blocks object-hijack attempts
--    3. caller role check     - only a boss may create staff
--    4. role hard-coded       - cannot be used to create a boss
--    5. revoke from anon      - anonymous callers are refused
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_staff_account(
  p_code text,
  p_password text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $fn$
declare
  v_uid uuid;
  v_email text;
  v_code text;
  v_name text;
  v_existing uuid;
begin
  -- 1. caller must be a signed-in boss
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'boss'
  ) then
    raise exception 'only a boss can create staff accounts';
  end if;

  -- 2. validate input
  -- The code becomes part of an internal email address, so it must
  -- contain only safe characters. CJK, spaces and "@" would produce
  -- an invalid email; catching it here gives a readable message
  -- instead of a cryptic error from the auth layer.
  v_code := lower(trim(coalesce(p_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  if length(coalesce(p_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_code);
  v_email := v_code || '@staff.pr';

  -- 3. already created? return it instead of duplicating
  select id into v_existing from auth.users where email = v_email;
  if v_existing is not null then
    update public.profiles
       set boss_id = auth.uid(),
           name = v_name
     where id = v_existing;
    return jsonb_build_object(
      'ok', true,
      'id', v_existing,
      'code', v_code,
      'already_existed', true
    );
  end if;

  -- 4. create the account
  v_uid := gen_random_uuid();

  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_uid,
    'authenticated',
    'authenticated',
    v_email,
    crypt(p_password, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', v_name),
    now(), now(),
    '', '', '', ''
  );

  -- auth.identities row. Without it Supabase Auth considers the
  -- user to have no sign-in method.
  insert into auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at, id
  ) values (
    v_uid::text, v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email),
    'email', now(), now(), now(), gen_random_uuid()
  );

  -- 5. the profiles row is created by the handle_new_user trigger.
  --    Fill in the ownership and the real name here. The insert
  --    below also covers the case where that trigger is missing.
  insert into public.profiles (id, code, name, role, boss_id)
  values (v_uid, v_code, v_name, 'employee', auth.uid())
  on conflict (id) do update
    set boss_id = auth.uid(),
        name = v_name,
        code = v_code;

  update public.profiles
     set name = v_name, boss_id = auth.uid()
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'id', v_uid,
    'code', v_code,
    'already_existed', false
  );
end;
$fn$;

-- Only signed-in users may call it; anonymous access is refused.
revoke all on function public.create_staff_account(text, text, text) from public;
revoke all on function public.create_staff_account(text, text, text) from anon;
grant execute on function public.create_staff_account(text, text, text)
  to authenticated;

-- ============================================================
--  Verify after running:
--
--    select proname, prosecdef from pg_proc
--    where proname = 'create_staff_account';
--
--  prosecdef = true means it is security definer (required).
-- ============================================================
