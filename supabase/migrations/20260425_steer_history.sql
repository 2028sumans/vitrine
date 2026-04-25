-- Steer history: every free-text refinement a user submits in /shop's
-- Steer input, captured as raw text + structured interp + outcome counters.
--
-- Used to:
--   1. Show "you previously asked for X" in UI (recall / repeat).
--   2. Re-prompt Claude with last K steers for coreference resolution
--      ("more like the last one I liked").
--   3. Tune the steer interpreter — track which interp shapes correlate
--      with downstream saves vs. abandons via outcome_saves /
--      outcome_dismisses.
--
-- Written by /api/steer-interpret on every successful interp.
-- Read by lib/steer-history.ts (helpers consumed by both /shop and the
-- Claude prompt pipeline).

create table if not exists public.user_steer_history (
  id                bigserial primary key,
  user_token        text not null,
  raw_text          text not null,
  -- Full SteerInterpretation as parsed by Claude / fast-parse. JSONB for
  -- index-friendly query patterns ("show me steers that touched colors").
  interp            jsonb not null,
  -- Optional category context — when the user steered while inside a
  -- specific category page, we record which category so we can prefer
  -- in-category steers when re-prompting.
  category_slug     text,
  -- Outcome counters — bumped by /api/taste/click and /api/onboarding/save
  -- when the user saves / dismisses an item within K interactions of this
  -- steer. Used to score the steer's effectiveness for future tuning.
  outcome_saves     int not null default 0,
  outcome_dismisses int not null default 0,
  created_at        timestamptz not null default now()
);

-- Most queries are "give me the last N steers for this user," so we want
-- a covering index on (user_token, created_at desc). The category filter
-- is sometimes added as a secondary clause.
create index if not exists user_steer_history_token_recent_idx
  on public.user_steer_history (user_token, created_at desc);

-- Optional secondary index for category-scoped reads. Cheap to add.
create index if not exists user_steer_history_token_category_idx
  on public.user_steer_history (user_token, category_slug, created_at desc);
