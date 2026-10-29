-- ============================================================
--  Create an account directly with SQL.
--
--  Use this for:
--    - the boss's own account (the very first one)
--    - a test account for verifying the create-staff function
--
--  It is faster than the dashboard: just change the two values
--  below and run it.
--
--  ASCII-only on purpose. Earlier versions of these SQL files had
--  Chinese comments and got re-encoded in transit; a full-width
--  dollar sign then broke the function body delimiter and produced
--  a misleading "syntax error at or near ^" from PostgreSQL.
-- ============================================================

do $mk$
declare
  -- ============ CHANGE THESE TWO ============
  v_code text := 'testboss001';        -- login name (boss phone number)
  v_pass text := 'test123456';         -- password, at least 6 chars
  -- ==========================================
  v_role text := 'boss';               -- 'boss' or 'employee'
  v_name text := 'Boss';
  v_domain text;
  v_email text;
  v_uid uuid := gen_random_uuid();
begin
  v_domain := case when v_role = 'boss' then '@boss.pr' else '@staff.pr' end;
  v_email := lower(v_code) || v_domain;

  if exists (select 1 from auth.users where email = v_email) then
    raise notice 'Account % already exists, nothing to do', v_email;
    return;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_uid, 'authenticated', 'authenticated', v_email,
    crypt(v_pass, gen_salt('bf')),
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

  -- The handle_new_user trigger creates the profiles row.
  -- This covers the case where the trigger is missing.
  insert into public.profiles (id, code, name, role)
  values (v_uid, lower(v_code), v_name, v_role)
  on conflict (id) do update
    set role = v_role, name = v_name, code = lower(v_code);

  update public.profiles
     set role = v_role, name = v_name
   where id = v_uid;

  raise notice 'Created % (role=%) id=%', v_email, v_role, v_uid;
end;
$mk$;

-- ============================================================
--  Confirm:
--    select u.email, p.code, p.name, p.role
--    from auth.users u join public.profiles p on p.id = u.id
--    order by u.created_at desc limit 5;
-- ============================================================
