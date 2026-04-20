-- Add dwell-time capture to product_impressions so fast-swipes can surface
-- as strong negative training signal for the taste head. Nullable because:
--   (a) legacy rows have no dwell data and shouldn't get a synthetic zero,
--   (b) grid-view impressions don't produce a well-defined dwell, and
--   (c) the first time a card enters the viewport the trainer treats "null
--       dwell" as "impressed but not graded" — weaker than a recorded value.

alter table public.product_impressions
  add column if not exists dwell_ms integer;

-- Queries in scripts/train-taste-head.mjs typically filter by user_token
-- and order by id/created_at; a composite index keeps the per-user pull
-- cheap even as impressions grow.
create index if not exists product_impressions_user_created_idx
  on public.product_impressions (user_token, id desc);
