-- ============================================================
--  Accounts: one login name, no duplicates, always an email
--
--  Naming change first, because it drives the data model:
--  the login name used to be "phone number" for a boss and
--  "staff number" for an employee. It is really just an ACCOUNT
--  NAME, so both are the same concept now. One namespace, and it
--  must be unique across both roles.
--
--  Two bugs this fixes:
--
--  1. create_staff_account used to REASSIGN an existing account to
--     whichever boss called it. Boss B creating a staff code that
--     boss A already used would silently move A's employee over to
--     B. That is a cross-tenant hijack.
--
--  2. Staff accounts had no real email, so a forgotten password
--     could only be reset by their boss. Now they get one too.
--
--  This file is ASCII-only on purpose. A full-width character in a
--  comment once broke a dollar-quote delimiter here.
-- ============================================================

drop function if exists public.create_staff_account(text, text, text);

create or replace function public.create_staff_account(
  p_code text,
  p_password text,
  p_name text,
  p_email text default null
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
  v_owner uuid;
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

  -- 2. validate
  v_code := lower(trim(coalesce(p_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  if length(coalesce(p_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_code);

  -- 3. ACCOUNT NAME MUST BE UNIQUE.
  --
  --    The old code would take over an existing account and point it
  --    at the calling boss. Now:
  --      * mine already        -> return it (safe to retry)
  --      * somebody else's     -> refuse, never steal
  --
  --    CAREFUL with the order: the INTO list must match the SELECT
  --    list. An earlier version had `into v_owner, v_uid` here,
  --    which silently swapped them - and because a boss account has
  --    boss_id = null, the whole uniqueness check was skipped for
  --    those rows, letting a staff account reuse a boss's code.
  select boss_id, id into v_owner, v_uid
    from public.profiles
   where lower(code) = v_code
   limit 1;

  if v_uid is not null then
    /* v_owner is only set when the existing row is an employee.
       A boss (boss_id null) can never be "mine", so it falls
       through to the refusal below - which is what we want. */
    if v_owner is not null and v_owner = auth.uid() then
      return jsonb_build_object(
        'ok', true,
        'id', v_uid,
        'code', v_code,
        'already_existed', true
      );
    end if;
    raise exception 'code already registered';
  end if;

  -- 4. email
  v_email := nullif(trim(coalesce(p_email, '')), '');

  if v_email is not null then
    if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'email looks invalid';
    end if;
    if exists (
      select 1 from auth.users where lower(email) = lower(v_email)
    ) then
      raise exception 'email already registered';
    end if;
  else
    v_email := v_code || '@staff.pr';
    if exists (select 1 from auth.users where email = v_email) then
      raise exception 'code already registered';
    end if;
  end if;

  -- 5. create the account
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
    set boss_id = auth.uid(),
        name = v_name,
        code = v_code,
        email = v_email;

  update public.profiles
     set name = v_name, boss_id = auth.uid(), email = v_email
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'id', v_uid,
    'code', v_code,
    'email', v_email,
    'already_existed', false
  );
end;
$fn$;

revoke all on function public.create_staff_account(text, text, text, text) from public;
revoke all on function public.create_staff_account(text, text, text, text) from anon;
grant execute on function public.create_staff_account(text, text, text, text)
  to authenticated;

-- ============================================================
--  Verify:
--    select proname, prosecdef from pg_proc
--    where proname = 'create_staff_account';
-- ============================================================
