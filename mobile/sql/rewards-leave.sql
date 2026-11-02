-- ============================================================
--  Rewards (the shop) and leave requests.
--
--  Both are the same shape: a boss-owned catalogue, a request from
--  a team member, and a decision from the boss. Kept in one file
--  because the permission rules are identical.
--
--  Rewards
--  -------
--  * The boss maintains a small catalogue: title + price in points.
--  * Redeeming spends points immediately (the merit row is written
--    in the same call, so the balance can never go negative by
--    double-clicking).
--  * The redemption keeps a SNAPSHOT of the title and price, so
--    deleting a reward later does not rewrite history.
--
--  Leave
--  -----
--  * Ask, decide, done. Approved leave is informational for now:
--    it shows on the dashboard, it does not automatically freeze
--    points (that needs a rule for which days count, and guessing
--    that rule would do more harm than good).
--
--  This file is ASCII-only on purpose.
-- ============================================================

-- ------------------------------------------------------------
--  Catalogue
-- ------------------------------------------------------------
create table if not exists public.rewards (
  id          uuid primary key default gen_random_uuid(),
  boss_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  cost        integer not null check (cost > 0),
  detail      text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists rewards_boss_idx
  on public.rewards (boss_id, created_at desc);

alter table public.rewards enable row level security;

drop policy if exists "see team rewards" on public.rewards;
create policy "see team rewards" on public.rewards
  for select using (
    boss_id = auth.uid()
    or boss_id = (select boss_id from public.profiles where id = auth.uid())
  );

revoke insert, update, delete on public.rewards from anon, authenticated;

-- ------------------------------------------------------------
--  Redemptions
-- ------------------------------------------------------------
create table if not exists public.redemptions (
  id           uuid primary key default gen_random_uuid(),
  boss_id      uuid not null references public.profiles(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  reward_id    uuid references public.rewards(id) on delete set null,
  title        text not null,
  cost         integer not null,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

create index if not exists redemptions_boss_idx
  on public.redemptions (boss_id, created_at desc);

alter table public.redemptions enable row level security;

drop policy if exists "see own redemptions" on public.redemptions;
create policy "see own redemptions" on public.redemptions
  for select using (
    profile_id = auth.uid() or boss_id = auth.uid()
  );

revoke insert, update, delete on public.redemptions from anon, authenticated;

-- ------------------------------------------------------------
--  Leave requests
-- ------------------------------------------------------------
create table if not exists public.leave_requests (
  id             uuid primary key default gen_random_uuid(),
  boss_id        uuid not null references public.profiles(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  from_date      date not null,
  to_date        date not null,
  reason         text not null default '',
  status         text not null default 'pending',
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  decision_note  text not null default ''
);

create index if not exists leave_boss_idx
  on public.leave_requests (boss_id, created_at desc);

alter table public.leave_requests enable row level security;

drop policy if exists "see own leave" on public.leave_requests;
create policy "see own leave" on public.leave_requests
  for select using (
    profile_id = auth.uid() or boss_id = auth.uid()
  );

revoke insert, update, delete on public.leave_requests from anon, authenticated;

-- ============================================================
--  Rewards functions
-- ============================================================

create or replace function public.add_reward(
  p_title text, p_cost integer, p_detail text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_title text := trim(coalesce(p_title, ''));
  v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if not exists (
    select 1 from public.profiles where id = v_uid and role = 'boss'
  ) then
    raise exception 'only a boss can add rewards';
  end if;
  if v_title = '' then raise exception 'title required'; end if;
  if p_cost is null or p_cost <= 0 then
    raise exception 'cost must be positive';
  end if;

  insert into public.rewards (boss_id, title, cost, detail)
  values (v_uid, v_title, p_cost, coalesce(p_detail, ''))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$fn$;

create or replace function public.set_reward_active(
  p_reward uuid, p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  update public.rewards
     set active = coalesce(p_active, true)
   where id = p_reward and boss_id = v_uid;

  if not found then
    raise exception 'not your reward';
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

-- ------------------------------------------------------------
--  redeem_reward - spend points, atomically
-- ------------------------------------------------------------
create or replace function public.redeem_reward(p_reward uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_reward public.rewards%rowtype;
  v_balance integer;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  select * into v_reward from public.rewards where id = p_reward;
  if not found then raise exception 'no such reward'; end if;
  if not v_reward.active then raise exception 'reward is inactive'; end if;

  select coalesce(sum(amount), 0) into v_balance
    from public.merit_ledger where profile_id = v_uid;

  if v_balance < v_reward.cost then
    raise exception 'not enough points, balance %', v_balance;
  end if;

  insert into public.redemptions (
    boss_id, profile_id, reward_id, title, cost
  ) values (
    v_reward.boss_id, v_uid, v_reward.id, v_reward.title, v_reward.cost
  ) returning id into v_id;

  insert into public.merit_ledger (
    boss_id, profile_id, amount, kind, reason, source_id
  ) values (
    v_reward.boss_id, v_uid, -v_reward.cost, 'redeem', '', v_id
  );

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'cost', v_reward.cost,
    'balance', v_balance - v_reward.cost
  );
end;
$fn$;

create or replace function public.decide_redemption(
  p_redemption uuid, p_given boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  update public.redemptions
     set status = case when coalesce(p_given, false)
                       then 'given' else 'rejected' end,
         decided_at = now()
   where id = p_redemption and boss_id = v_uid and status = 'pending';

  if not found then
    raise exception 'already decided or not yours';
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

-- ============================================================
--  Leave functions
-- ============================================================

create or replace function public.request_leave(
  p_from date, p_to date, p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_boss uuid;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  if p_from is null or p_to is null then
    raise exception 'dates required';
  end if;
  if p_to < p_from then
    raise exception 'end date is before start date';
  end if;

  select coalesce(boss_id, id) into v_boss
    from public.profiles where id = v_uid;

  if v_boss is null then raise exception 'no such profile'; end if;

  if exists (
    select 1 from public.leave_requests
    where profile_id = v_uid and status = 'pending'
  ) then
    raise exception 'already asked, waiting for a decision';
  end if;

  insert into public.leave_requests (
    boss_id, profile_id, from_date, to_date, reason
  ) values (
    v_boss, v_uid, p_from, p_to, coalesce(p_reason, '')
  ) returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$fn$;

create or replace function public.decide_leave(
  p_leave uuid, p_approved boolean, p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  update public.leave_requests
     set status = case when coalesce(p_approved, false)
                       then 'approved' else 'rejected' end,
         decided_at = now(),
         decision_note = coalesce(p_note, '')
   where id = p_leave and boss_id = v_uid and status = 'pending';

  if not found then
    raise exception 'already decided or not yours';
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

-- ------------------------------------------------------------
--  Grants
-- ------------------------------------------------------------
revoke all on function public.add_reward(text, integer, text) from public;
revoke all on function public.set_reward_active(uuid, boolean) from public;
revoke all on function public.redeem_reward(uuid) from public;
revoke all on function public.decide_redemption(uuid, boolean) from public;
revoke all on function public.request_leave(date, date, text) from public;
revoke all on function public.decide_leave(uuid, boolean, text) from public;

revoke all on function public.add_reward(text, integer, text) from anon;
revoke all on function public.set_reward_active(uuid, boolean) from anon;
revoke all on function public.redeem_reward(uuid) from anon;
revoke all on function public.decide_redemption(uuid, boolean) from anon;
revoke all on function public.request_leave(date, date, text) from anon;
revoke all on function public.decide_leave(uuid, boolean, text) from anon;

grant execute on function public.add_reward(text, integer, text) to authenticated;
grant execute on function public.set_reward_active(uuid, boolean) to authenticated;
grant execute on function public.redeem_reward(uuid) to authenticated;
grant execute on function public.decide_redemption(uuid, boolean) to authenticated;
grant execute on function public.request_leave(date, date, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;

-- ============================================================
--  Verify:
--    select * from public.rewards limit 5;
--    select * from public.leave_requests limit 5;
-- ============================================================
