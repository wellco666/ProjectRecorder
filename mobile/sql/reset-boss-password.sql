-- Reset the password of the boss account that actually has data.
--
-- Background: the owner registered the same phone number five times.
-- The reason is a real design hole -- the "forgot password" path
-- requires the OLD password, so forgetting it means starting over
-- with a brand new account every time.
--
-- This sets a temporary password so the owner can get back in and
-- change it from inside the app (Me -> Change password -> set a new one).
--
-- Keep this file pure ASCII: a full-width character once broke a
-- dollar-quote delimiter here.

update auth.users
   set encrypted_password = extensions.crypt('reset2026', extensions.gen_salt('bf')),
       updated_at = now()
 where email = '19155037002-2@boss.pr';

select email, updated_at as changed_at
  from auth.users
 where email like '19155037002%'
 order by email;
