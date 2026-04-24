-- Allow users to skip the onboarding quiz.
--
-- Two small changes to the user_onboarding table:
--   1. age_range becomes nullable — skipped users have no age on file
--   2. skipped BOOLEAN column — explicit flag so we can distinguish
--      "finished the quiz" from "explicitly bailed out"
--
-- The gate logic (hasCompletedOnboarding → row exists) already treats
-- either state as "don't re-prompt", so no downstream code needs to change
-- to accept skipped rows.

alter table public.user_onboarding
  alter column age_range drop not null;

alter table public.user_onboarding
  add column if not exists skipped boolean not null default false;

-- completed_at still gets set on skip (it's the timestamp of "the user
-- dealt with the onboarding screen," not specifically of "they filled
-- it out"). The skipped flag is what disambiguates.
