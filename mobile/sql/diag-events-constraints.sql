-- task_events constraints + column defaults.
-- The 23514 (check_violation) probably comes from a kind allow-list
-- that predates the rejected / extend / extend_ok / extend_no events.
select c.conname as constraint_name,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'public.task_events'::regclass
   and c.contype = 'c';
