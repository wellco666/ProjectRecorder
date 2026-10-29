-- ============================================================
--  Turn on Realtime for task_events.
--
--  ASCII-only on purpose (a stray full-width character once
--  broke the dollar-quote delimiters, see sql/migrate-notify.sql).
--
--  ## Why this is needed
--
--  The app can poll every 15 seconds, but "the moment the boss
--  assigns a task, the employee's phone pops up" needs the
--  server to PUSH. Supabase Realtime does exactly that over a
--  WebSocket, and the delay drops from ~15s to under a second.
--
--  Subscribing without this gives a confusing result: the join
--  reply says "ok", but a second later the server sends
--
--     Unable to subscribe to changes with given parameters.
--     Please check Realtime is enabled ...
--
--  so the app quietly keeps polling and the user sees no
--  improvement while nothing reports an error.
--
--  ## What it does
--
--  Adds the table to the supabase_realtime publication, which is
--  what the Realtime server reads from. Row security still
--  applies: the table's SELECT policy is
--
--     boss_id = auth.uid() or employee_id = auth.uid()
--
--  so an employee only ever receives their own events and a boss
--  only their own team's. The filtering happens on the server.
--
--  Running this twice is harmless.
-- ============================================================

do $$
begin
  -- The publication normally already exists on a Supabase
  -- project. Create it only if this is an unusual setup.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  -- Add the table only if it is not published yet.
  -- ALTER PUBLICATION ... ADD TABLE errors out on a duplicate,
  -- so guard it.
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'task_events'
  ) then
    alter publication supabase_realtime add table public.task_events;
  end if;
end
$$;

-- ============================================================
--  Verify
-- ============================================================
--
--   select schemaname, tablename
--     from pg_publication_tables
--    where pubname = 'supabase_realtime';
--   -- task_events must be in the list
--
-- Then in the app: assign a task and watch the employee's phone.
-- The popup should appear within about a second.
