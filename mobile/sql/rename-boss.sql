-- ============================================================
--  Rename the boss account / reset its password.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## Why
--
--  The boss account was created earlier with the placeholder
--  values from create-account.sql, so the login name is literally
--  "testboss001". Since the login screen allows only one boss,
--  creating a second one is refused.
--
--  Rather than deleting and recreating, this just renames the
--  existing account. Change the two values below and run it once.
--
--  ## Important: the internal email changes too
--
--  Login is "code + password", but underneath it is still an
--  email account: <code>@boss.pr. So the auth.users row has to be
--  updated as well, keyed on the OLD code.
-- ============================================================

do $rename$
declare
  -- ============ CHANGE THESE THREE ============
  v_old_code text := 'testboss001';       -- current login name
  v_new_code text := '19155025818';       -- set this to your phone number
  v_new_pass text := 'change-me-123456';  -- password you will type in the app
  -- ============================================
  v_old_email text;
  v_new_email text;
  v_uid uuid;
  v_new_name text := 'Boss';   -- display name; change if you like
begin
  ------------------------------------------------------------
  -- 1. find the account by its current login name
  ------------------------------------------------------------
  v_old_email := lower(v_old_code) || '@boss.pr';
  v_new_email := lower(v_new_code) || '@boss.pr';

  select id into v_uid from auth.users where email = v_old_email;
  if v_uid is null then
    raise exception 'no account found for %', v_old_email;
  end if;

  ------------------------------------------------------------
  -- 2. validate the new code. It becomes part of the internal
  --    email, so CJK, spaces and "@" would make it invalid.
  ------------------------------------------------------------
  if lower(v_new_code) !~ '^[a-z0-9._-]{3,20}$' then
    raise exception 'new code may only contain letters, digits, dot, underscore and dash, 3-20 chars';
  end if;
  if length(coalesce(v_new_pass, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;

  ------------------------------------------------------------
  -- 3. refuse if the target name is already taken by someone else
  ------------------------------------------------------------
  if exists (select 1 from auth.users
              where email = v_new_email and id <> v_uid) then
    raise exception 'the name % is already taken', v_new_code;
  end if;

  ------------------------------------------------------------
  -- 4. update the auth row: email + password
  ------------------------------------------------------------
  update auth.users
     set email = v_new_email,
         encrypted_password = crypt(v_new_pass, gen_salt('bf')),
         email_confirmed_at = now(),
         updated_at = now()
   where id = v_uid;

  -- The identity row carries a copy of the email. Missing this
  -- leaves a stale address behind and some GoTrue versions refuse
  -- to sign in because identity_data no longer matches.
  update auth.identities
     set identity_data = jsonb_build_object(
           'sub', v_uid::text, 'email', v_new_email),
         provider_id = v_uid::text,
         updated_at = now()
   where user_id = v_uid;

  ------------------------------------------------------------
  -- 5. update the profile
  ------------------------------------------------------------
  update public.profiles
     set code = lower(v_new_code),
         name = coalesce(nullif(trim(v_new_name), ''), name),
         role = 'boss',
         updated_at = now()
   where id = v_uid;

  raise notice 'Renamed % -> %', v_old_email, v_new_email;
end;
$rename$;

-- ============================================================
--  Confirm it worked:
--
--    select u.email, p.code, p.name, p.role
--    from auth.users u join public.profiles p on p.id = u.id
--    where p.role = 'boss';
--
--  Then log in from the app with the new code + new password.
-- ============================================================
