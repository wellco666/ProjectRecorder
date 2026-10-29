-- ============================================================
--  Log in by account name, without leaking the email address.
--
--  The problem
--  -----------
--  login_emails(p_code) was granted to anon so the login screen
--  could turn "19155025818" into the auth email. But that means
--  anyone holding the anon key (it ships inside the apk) can walk
--  the space of account names and harvest real email addresses.
--
--  That was tolerable when every account carried a fake
--  <code>@boss.pr address. It is not tolerable now that accounts
--  hold real Gmail / QQ addresses.
--
--  The fix
--  -------
--  Ask for the password as well and check it *inside* the
--  database, against auth.users.encrypted_password (bcrypt).
--
--    * wrong password  -> no email leaves the database
--    * no such account -> still reported, so the login screen can
--                         keep saying "no such account" (that was a
--                         deliberate feature: it stops people from
--                         re-registering when they simply forgot)
--
--  What is still disclosed: whether an account name exists. What
--  is no longer disclosed: the email behind it.
--
--  Bonus: the client no longer has to guess between @boss.pr and
--  @staff.pr, so login is 2 requests instead of up to 4.
--
--  This file is ASCII-only on purpose.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.login_email(p_code text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $fn$
declare
  v_code text := lower(trim(coalesce(p_code, '')));
  v_exists boolean;
  v_email text;
begin
  if v_code = '' then
    return jsonb_build_object('status', 'no_account');
  end if;

  select exists (
    select 1 from public.profiles where lower(code) = v_code
  ) into v_exists;

  if not v_exists then
    return jsonb_build_object('status', 'no_account');
  end if;

  -- password is checked here, in the database, so a wrong guess
  -- never gets the address back
  select u.email
    into v_email
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(p.code) = v_code
     and u.encrypted_password is not null
     and u.encrypted_password =
         extensions.crypt(coalesce(p_password, ''), u.encrypted_password)
   order by case when p.role = 'boss' then 0 else 1 end
   limit 1;

  if v_email is null then
    return jsonb_build_object('status', 'bad_password');
  end if;

  return jsonb_build_object('status', 'ok', 'email', v_email);
end;
$fn$;

revoke all on function public.login_email(text, text) from public;
grant execute on function public.login_email(text, text) to anon, authenticated;

-- ============================================================
--  login_emails is revoked separately, *after* the new apk is
--  installed. Revoking it now would lock out the currently
--  installed build: it still calls login_emails during login.
--
--    revoke execute on function public.login_emails(text) from anon;
--
-- ============================================================
