-- Verify the task acceptance / extension migration landed.
-- Pure ASCII: SQL files must be ASCII (see selfcheck).
select 'tasks.accept_status' as item,
       count(*)::text as state
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tasks'
   and column_name in ('accept_status', 'accept_reason', 'accept_at')
union all
select 'task_requests table',
       case when count(*) > 0 then 'present' else 'MISSING' end
  from information_schema.tables
 where table_schema = 'public' and table_name = 'task_requests'
union all
select 'accept_task()',
       case when count(*) > 0 then 'present' else 'MISSING' end
  from information_schema.routines
 where routine_schema = 'public' and routine_name = 'accept_task'
union all
select 'request_task_extension()',
       case when count(*) > 0 then 'present' else 'MISSING' end
  from information_schema.routines
 where routine_schema = 'public' and routine_name = 'request_task_extension'
union all
select 'decide_task_extension()',
       case when count(*) > 0 then 'present' else 'MISSING' end
  from information_schema.routines
 where routine_schema = 'public' and routine_name = 'decide_task_extension'
union all
select 'task_requests RLS',
       case when count(*) > 0 then 'enabled' else 'MISSING' end
  from pg_class
 where relname = 'task_requests' and relrowsecurity = true;
