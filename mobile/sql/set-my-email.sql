-- ============================================================
--  Let a signed-in user set their own recovery email directly.
--
--  Why not use Supabase's updateUser({ email })?
--
--  Because it is unusable for every legacy account in this app.
--
--  Those accounts were created with an internal placeholder
--  address (<code>@boss.pr / @staff.pr). That domain does not
--  exist, so any mail sent to it bounces.
--
--  With "Secure email change" enabled, Supabase requires BOTH the
--  old and the new address to confirm. The old one can never
--  confirm, so the change never completes: the user is stuck on
--  "pending" forever, and the very people who need a real email
--  (the ones with placeholders) are the ones who cannot get one.
--
--  So this function writes the new address straight into
--  auth.users, the matching identity row and the profile row.
--  No confirmation mail, no pending state.
--
--  Trade-off, stated plainly: this does not prove the address
--  exists. The app guards the obvious typos, and the user can
--  prove it themselves by using "forgot password" once.
--
--  Safety: SECURITY DEFINER runs as the owner so it can write
--  auth.users, but it can only ever touch auth.uid()'s own row -
--  the caller's identity comes from the JWT, not from an argument.
--
--  This file is ASCII-only on purpose.
-- ============================================================

create or replace function public.set_my_email(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));

  if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email looks invalid';
  end if;

  if exists (
    select 1 from auth.users
    where lower(email) = v_email and id <> v_uid
  ) then
    raise exception 'email already registered';
  end if;

  update auth.users
     set email = v_email,
         email_change = '',
         email_change_token_new = '',
         email_change_token_current = '',
         email_change_confirm_status = 0,
         email_confirmed_at = now(),
         updated_at = now()
   where id = v_uid;

  update auth.identities
     set identity_data = jsonb_set(
           identity_data, '{email}', to_jsonb(v_email)
         ),
         updated_at = now()
   where user_id = v_uid;

  update public.profiles
     set email = v_email
   where id = v_uid;

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$fn$;

revoke all on function public.set_my_email(text) from public;
revoke all on function public.set_my_email(text) from anon;
grant execute on function public.set_my_email(text) to authenticated;

-- ============================================================
--  Verify:
--    select proname, prosecdef from pg_proc
--    where proname = 'set_my_email';
-- ============================================================
