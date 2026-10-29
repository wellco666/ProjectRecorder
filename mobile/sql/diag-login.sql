-- ============================================================
--  Diagnose why SQL-created accounts cannot sign in.
--
--  Posts no data, changes nothing. Read-only checks.
--  ASCII only (see the note in create-staff-rpc.sql).
-- ============================================================

with target as (
  select id, email, encrypted_password, email_confirmed_at,
         aud, role, instance_id,
         length(encrypted_password) as hash_len,
         left(encrypted_password, 7) as hash_prefix
  from auth.users
  where email like 'auto%@staff.pr' or email like 'diag%@staff.pr'
  order by created_at desc
  limit 1
)
select
  email,
  -- 1. how many rows would the login lookup find?
  (select count(*) from auth.users u2 where u2.email = target.email) as email_rows,
  -- 2. is the stored email exactly lower-case?
  email = lower(email) as email_is_lower,
  -- 3. is the hash a bcrypt hash?
  hash_prefix,
  hash_len,
  -- 4. does the hash verify against the password we set?
  encrypted_password = crypt('staff123456', encrypted_password) as pass_matches,
  -- 5. email confirmed?
  email_confirmed_at is not null as confirmed,
  -- 6. required auth columns
  aud,
  role,
  instance_id,
  -- 7. is there an identities row?
  (select count(*) from auth.identities i
    where i.user_id = target.id) as identity_rows,
  -- 8. does that identity use provider_id = user id?
  (select provider_id from auth.identities i
    where i.user_id = target.id limit 1) as identity_provider_id,
  -- 9. is the profile linked?
  (select role from public.profiles p where p.id = target.id) as profile_role
from target;
