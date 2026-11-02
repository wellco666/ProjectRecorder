-- ============================================================
--  Register this device for push notifications.
--
--  The problem
--  -----------
--  The client did:
--      upsert({ cid, profile_id, ... }, { onConflict: "cid" })
--
--  `cid` is unique, so if the SAME PHONE once registered under a
--  different account (the boss logged out, an employee logged in,
--  or the same person has two accounts), the upsert takes the
--  UPDATE path. RLS says "you may only touch rows where
--  profile_id = auth.uid()", so the conflicting row is invisible
--  to the caller and Postgres reports:
--
--      new row violates row-level security policy (USING expression)
--
--  Result: the app keeps showing "push not registered" forever,
--  on that device, until someone deletes the row by hand. Push
--  goes to a stale address and the phone silently receives nothing.
--
--  The fix
--  -------
--  A device belongs to whoever is logged in on it right now.
--  This function takes the cid over: it removes any existing row
--  with that cid (whatever account owns it) and inserts one for
--  the caller. Running as SECURITY DEFINER is what makes the
--  takeover possible without opening up the table.
--
--  One cid maps to exactly one profile at a time, which is what
--  the push sender expects.
--
--  This file is ASCII-only on purpose.
-- ============================================================

create or replace function public.register_push_device(
  p_cid text,
  p_platform text default 'android',
  p_settings jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_cid text := trim(coalesce(p_cid, ''));
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  if v_cid = '' then
    raise exception 'cid required';
  end if;

  /* Take the device over. The row may belong to a previous
     account on this same phone - that is exactly the case that
     used to fail. */
  delete from public.push_devices where cid = v_cid;

  insert into public.push_devices (
    cid, profile_id, platform, notify_settings, updated_at
  ) values (
    v_cid,
    v_uid,
    coalesce(nullif(trim(p_platform), ''), 'android'),
    coalesce(p_settings, '{}'::jsonb),
    now()
  );

  return jsonb_build_object('ok', true, 'cid', v_cid);
end;
$fn$;

revoke all on function public.register_push_device(text, text, jsonb) from public;
revoke all on function public.register_push_device(text, text, jsonb) from anon;
grant execute on function public.register_push_device(text, text, jsonb)
  to authenticated;

-- ============================================================
--  Verify:
--    select cid, profile_id, updated_at
--      from public.push_devices order by updated_at desc limit 5;
-- ============================================================
