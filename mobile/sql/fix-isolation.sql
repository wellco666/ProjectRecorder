-- ============================================================
--  Fix an isolation hole in the profile policies.
--
--  ASCII-only on purpose (see the note in create-staff-rpc.sql).
--
--  ## The bug
--
--  Found by e2e-multiboss.js. Two bosses each saw ALL 14 staff
--  accounts instead of only their own.
--
--  Cause: both policies contained "boss_id is null", so every boss
--  could read -- and, via the update policy, claim -- any account
--  that had no owner yet.
--
--  Those clauses were added for an earlier "find an unclaimed
--  account, then claim it" flow. That flow no longer exists:
--  create_staff_account sets boss_id in the same statement that
--  creates the employee, so an employee is never unclaimed.
--
--  ## What this changes
--
--    before:  boss sees own staff + every unclaimed account
--    after:   boss sees own staff only
--
--  staff README: this is a small, self-contained patch. Running it
--  twice is harmless.
-- ============================================================

-- Reading your own profile, plus (as a boss) your own staff.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select
  using (
    id = auth.uid()
    or boss_id = auth.uid()
  );

-- A boss may only update rows that are already theirs. Note both
-- clauses: "using" picks the rows, "with check" constrains the
-- result, and the result must still belong to the same boss.
drop policy if exists "boss updates staff" on public.profiles;
create policy "boss updates staff" on public.profiles for update
  using (boss_id = auth.uid())
  with check (boss_id = auth.uid());

-- ============================================================
--  Optional: deal with leftover unclaimed accounts
-- ============================================================
-- Accounts created before the fix may have boss_id = null. They
-- are now invisible to everyone, which is the safe default.
--
-- See them:
--
--   select code, name, created_at from public.profiles
--    where role = 'employee' and boss_id is null
--    order by created_at;
--
-- Delete them (cascades to their tasks and logs):
--
--   delete from public.profiles
--    where role = 'employee' and boss_id is null;
--
-- Or hand them to a boss -- replace the code:
--
--   update public.profiles
--      set boss_id = (select id from public.profiles
--                      where code = 'PUT-BOSS-CODE-HERE')
--    where role = 'employee' and boss_id is null;

-- ============================================================
--  Verify: after this, open the app as two different bosses and
--  confirm each staff list shows only its own people. Or run:
--
--    node e2e-multiboss.js
-- ============================================================
