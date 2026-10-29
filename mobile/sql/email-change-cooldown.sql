-- ============================================================
--  Email change: no confirmation, but at most once per 24 hours.
--
--  Why a cooldown instead of email confirmation?
--
--  Legacy accounts carry an internal placeholder address
--  (<code>@boss.pr) on a domain that does not exist. Supabase's
--  confirmation flow would need the OLD address to confirm too,
--  which is impossible - so those users could never bind a real
--  email at all. Waiting for a confirmation mail is also useless
--  when the whole point is "the mail never arrives".
--
--  So the address is written straight through. The cooldown is
--  what makes that safe enough:
--
--    * a typo can still be corrected - the account keeps working
--      because the password is unchanged
--    * a stolen session cannot quietly move the account to a new
--      inbox over and over
--
--  The first bind is always allowed: email_changed_at is null for
--  every existing account.
--
--  This file is ASCII-only on purpose.
-- ============================================================

alter table public.profiles
  add column if not exists email_changed_at timestamptz;

create or replace function public.set_my_email(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_last timestamptz;
  v_left_hours integer;
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

  -- cooldown: at most one change per 24 hours
  select email_changed_at into v_last
    from public.profiles where id = v_uid;

  if v_last is not null and v_last > now() - interval '24 hours' then
    v_left_hours := ceil(
      extract(epoch from (v_last + interval '24 hours' - now())) / 3600.0
    );
    if v_left_hours < 1 then
      v_left_hours := 1;
    end if;
    raise exception 'email change locked, % hours left', v_left_hours;
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
     set email = v_email,
         email_changed_at = now()
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'email', v_email,
    'next_change_at', now() + interval '24 hours'
  );
end;
$fn$;

revoke all on function public.set_my_email(text) from public;
revoke all on function public.set_my_email(text) from anon;
grant execute on function public.set_my_email(text) to authenticated;

-- ============================================================
--  Verify:
--    select id, code, email, email_changed_at
--      from public.profiles order by email_changed_at desc nulls last
--      limit 5;
-- ============================================================
