-- Add email+password ("MUSE account") sign-in support.
--
-- The users table already has email as UNIQUE NOT NULL. We add a nullable
-- password_hash column — nullable because Pinterest users don't have one
-- (they auth via OAuth, no password stored on our side).
--
-- Pinterest users have placeholder emails like `username@pinterest.muse`
-- (set in the Pinterest provider's `profile()` callback) so they can't
-- collide with real-email MUSE accounts.

alter table public.users
  add column if not exists password_hash text;

-- A partial index to speed up email lookups during the Credentials
-- provider's `authorize()` step. We only index rows with a password_hash
-- because Pinterest users are looked up by pinterest_id, never by email.
create index if not exists users_email_lower_with_password_idx
  on public.users (lower(email))
  where password_hash is not null;

-- RLS: MUSE account creation and sign-in both hit this table via the
-- service-role key (route handlers), so the existing "users_select_own"
-- policy from schema.sql still bounds client-side reads correctly.
