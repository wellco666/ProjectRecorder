-- Register each authenticated installation's GeTui CID.
-- Run after migrate-notify.sql. The AppSecret stays in Supabase secrets only.
create table if not exists public.push_devices (
  cid text primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null default 'android' check (platform = 'android'),
  notify_settings jsonb not null default '{"enabled":true,"system":true,"onTaskAssigned":true,"onTaskDone":true,"onTaskUndone":true}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.push_devices
  add column if not exists notify_settings jsonb not null
  default '{"enabled":true,"system":true,"onTaskAssigned":true,"onTaskDone":true,"onTaskUndone":true}'::jsonb;

create index if not exists idx_push_devices_profile
  on public.push_devices(profile_id);

alter table public.push_devices enable row level security;
drop policy if exists "users manage own push devices" on public.push_devices;
create policy "users manage own push devices" on public.push_devices
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

grant select, insert, update, delete on public.push_devices to authenticated;

-- task_events drives remote notifications, so a signed-in user may only
-- report a real event for a task assigned to them (or their own boss' task).
drop policy if exists "insert task events" on public.task_events;
create policy "insert task events" on public.task_events for insert to authenticated
  with check (
    (
      kind = 'assigned'
      and boss_id = auth.uid()
      and exists (
        select 1 from public.tasks t
         where t.id = public.task_events.task_id
           and t.boss_id = auth.uid()
           and t.employee_id = public.task_events.employee_id
           and t.title = public.task_events.title
      )
    )
    or
    (
      kind in ('done', 'undone')
      and employee_id = auth.uid()
      and exists (
        select 1 from public.tasks t
         where t.id = public.task_events.task_id
           and t.boss_id = public.task_events.boss_id
           and t.employee_id = auth.uid()
           and t.title = public.task_events.title
      )
    )
  );
