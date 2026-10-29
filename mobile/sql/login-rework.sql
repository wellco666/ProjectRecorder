-- ============================================================
--  Login rework: real email + no silent renaming
--
--  Two problems this fixes:
--
--  1. The old create_boss_account silently appended -2, -3, -4 ...
--     when a phone number was already taken. A user who registered
--     the same number five times ended up with five accounts and
--     never learned which login name to use.
--
--  2. Boss accounts used a fake address (<code>@boss.pr), so there
--     was no way to send a password reset email. Forgetting the
--     password meant registering again.
--
--  After this: registration refuses a taken number, and the boss
--  gives a real email that Supabase can send recovery codes to.
-- ============================================================

-- ------------------------------------------------------------
--  1. Drop the old 3-arg version first.
--
--  Adding a defaulted 4th parameter creates a NEW function; the old
--  one would still exist and 3-argument calls would become ambiguous.
-- ------------------------------------------------------------
drop function if exists public.create_boss_account(text, text, text);

create or replace function public.create_boss_account(
  p_code text,
  p_password text,
  p_name text,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $boss$
declare
  v_uid uuid;
  v_code text;
  v_name text;
  v_email text;
begin
  ------------------------------------------------------------
  -- 1. validate
  ------------------------------------------------------------
  v_code := lower(trim(coalesce(p_code, '')));
  if v_code !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;

  if length(coalesce(p_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  ------------------------------------------------------------
  -- 2. REFUSE a taken name.
  --
  --  Do not invent a suffix. The caller must be told the number is
  --  already in use so they can log in or recover instead of
  --  creating a duplicate they will never find again.
  ------------------------------------------------------------
  if exists (
    select 1 from public.profiles where lower(code) = v_code
  ) then
    raise exception 'code already registered';
  end if;

  if exists (
    select 1 from auth.users where email = v_code || '@boss.pr'
  ) then
    raise exception 'code already registered';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_code);

  ------------------------------------------------------------
  -- 3. email
  --
  --  With a real email the account can receive a password reset
  --  code from Supabase. Without one we fall back to the internal
  --  address so older callers keep working -- but those accounts
  --  cannot recover a forgotten password.
  ------------------------------------------------------------
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
    v_email := v_code || '@boss.pr';
  end if;

  ------------------------------------------------------------
  -- 4. create the account
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

  insert into public.profiles (id, code, name, role, email, boss_id)
  values (v_uid, v_code, v_name, 'boss', v_email, null)
  on conflict (id) do update
    set code = v_code, name = v_name, role = 'boss', email = v_email;

  return jsonb_build_object(
    'ok', true,
    'id', v_uid,
    'code', v_code,
    'email', v_email,
    'renamed', false
  );
end;
$boss$;

revoke all on function public.create_boss_account(text, text, text, text) from public;
grant execute on function public.create_boss_account(text, text, text, text)
  to anon, authenticated;


-- ------------------------------------------------------------
--  2. Which auth email belongs to this login name?
--
--  Boss accounts may now use a real email, employees still use the
--  internal staff address, and one name could exist in both roles.
--  So the app asks for all candidates and tries each with the
--  password. Boss first.
-- ------------------------------------------------------------
create or replace function public.login_emails(p_code text)
returns text[]
language sql
security definer
set search_path = public, auth, pg_temp
as $fn$
  select coalesce(array_agg(u.email order by
           case when p.role = 'boss' then 0 else 1 end,
           u.email), '{}'::text[])
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(p.code) = lower(trim(coalesce(p_code, '')));
$fn$;

revoke all on function public.login_emails(text) from public;
grant execute on function public.login_emails(text) to anon, authenticated;


-- ------------------------------------------------------------
--  3. Does this login name exist?
--
--  Lets the login screen say "no such account" instead of the
--  useless "wrong account or password", which is what made the
--  owner keep registering duplicates.
--
--  Trade-off: anyone holding a phone number can tell whether it is
--  registered. This is a small private tool; being able to see a
--  typo is worth more than hiding that.
-- ------------------------------------------------------------
create or replace function public.account_exists(p_code text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.profiles
     where lower(code) = lower(trim(coalesce(p_code, '')))
  );
$fn$;

revoke all on function public.account_exists(text) from public;
grant execute on function public.account_exists(text) to anon, authenticated;
