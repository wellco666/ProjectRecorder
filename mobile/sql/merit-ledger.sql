-- ============================================================
--  Merit ledger - the foundation of the points system.
--
--  One row per movement. The balance is never stored as a column;
--  it is always SUM(amount). That way a bug can never leave the
--  balance disagreeing with the history - the two cannot drift
--  apart because there is only one source of truth.
--
--  amount > 0  earned       amount < 0  spent or deducted
--
--  Writes go through merit_add only. Direct insert/update/delete
--  is revoked, so every movement is forced through one code path
--  where the permission check lives.
--
--  This file is ASCII-only on purpose.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.merit_ledger (
  id          uuid primary key default gen_random_uuid(),
  -- who owns this movement (the boss whose team it belongs to)
  boss_id     uuid not null references public.profiles(id) on delete cascade,
  -- whose wallet it lands in
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  amount      integer not null,
  -- task | hours | grade | redeem | leave | adjust
  kind        text not null default 'adjust',
  reason      text not null default '',
  -- optional link back to whatever caused it (a task id, a redemption id)
  source_id   uuid,
  created_at  timestamptz not null default now()
);

create index if not exists merit_ledger_profile_idx
  on public.merit_ledger (profile_id, created_at desc);

create index if not exists merit_ledger_boss_idx
  on public.merit_ledger (boss_id, created_at desc);

alter table public.merit_ledger enable row level security;

-- An employee sees their own wallet; a boss sees their team's.
drop policy if exists "see own merit" on public.merit_ledger;
create policy "see own merit" on public.merit_ledger
  for select using (
    profile_id = auth.uid() or boss_id = auth.uid()
  );

-- No direct writes from clients: everything goes through merit_add.
revoke insert, update, delete on public.merit_ledger from anon, authenticated;

-- ------------------------------------------------------------
--  merit_add - the single write path.
--
--  Only a boss may call it, and only for themselves or their own
--  staff. Amount 0 is refused: an empty movement is always a bug
--  upstream and would only clutter the history.
-- ------------------------------------------------------------
create or replace function public.merit_add(
  p_profile_id uuid,
  p_amount integer,
  p_kind text,
  p_reason text,
  p_source_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_caller uuid := auth.uid();
  v_target_boss uuid;
  v_balance integer;
begin
  if v_caller is null then
    raise exception 'not signed in';
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'amount must not be zero';
  end if;

  if abs(p_amount) > 1000000 then
    raise exception 'amount is out of range';
  end if;

  if not exists (
    select 1 from public.profiles where id = v_caller and role = 'boss'
  ) then
    raise exception 'only a boss can award merit';
  end if;

  select boss_id into v_target_boss
    from public.profiles where id = p_profile_id;

  if not found then
    raise exception 'no such profile';
  end if;

  if p_profile_id <> v_caller and v_target_boss is distinct from v_caller then
    raise exception 'not your staff';
  end if;

  insert into public.merit_ledger (
    boss_id, profile_id, amount, kind, reason, source_id
  ) values (
    v_caller, p_profile_id, p_amount,
    coalesce(nullif(trim(p_kind), ''), 'adjust'),
    coalesce(p_reason, ''),
    p_source_id
  );

  select coalesce(sum(amount), 0) into v_balance
    from public.merit_ledger where profile_id = p_profile_id;

  return jsonb_build_object('ok', true, 'balance', v_balance);
end;
$fn$;

revoke all on function public.merit_add(uuid, integer, text, text, uuid) from public;
revoke all on function public.merit_add(uuid, integer, text, text, uuid) from anon;
grant execute on function public.merit_add(uuid, integer, text, text, uuid)
  to authenticated;

-- ============================================================
--  Verify:
--    select count(*) from public.merit_ledger;
--    select * from public.merit_ledger order by created_at desc limit 5;
-- ============================================================
