-- Show every policy on tasks, so it is clear which one decides
-- whether an employee can see a task assigned to them.
select polname as policy_name,
       pg_get_expr(polqual, polrelid) as using_expression,
       pg_get_expr(polwithcheck, polrelid) as with_check,
       array_to_string(polroles::regrole[], ',') as roles,
       case polcmd
         when 'r' then 'select'
         when 'a' then 'insert'
         when 'w' then 'update'
         when 'd' then 'delete'
         else polcmd::text
       end as cmd
  from pg_policy
 where polrelid = 'public.tasks'::regclass
 order by polcmd, polname;
