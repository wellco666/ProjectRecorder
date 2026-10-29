-- List every check constraint on tasks and task_requests,
-- so the 23514 violation can be traced to an actual rule.
select c.conrelid::regclass::text as tbl,
       c.conname as constraint_name,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.contype = 'c'
   and c.conrelid in ('public.tasks'::regclass, 'public.task_requests'::regclass)
 order by 1, 2;
