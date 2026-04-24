-- One-time onboarding quiz answers. One row per user.
--
-- Written by app/api/onboarding/save on quiz completion. Read by
-- lib/taste-profile.ts to build the user's starting taste vector on every
-- downstream ranking request (shop category views, brand ordering, etc.).
--
-- Kept separate from user_taste_centroids so the "tailor your taste" flow
-- (which overwrites user_taste_centroids on every run) doesn't erase the
-- onboarding baseline. The two blend at read time in lib/taste-profile.ts.

create table if not exists public.user_onboarding (
  user_token       text primary key,

  -- Age bucket key from the quiz. One of:
  --   age-13-18, age-18-25, age-25-32, age-32-40, age-40-60
  -- Mapped to a hand-labeled golden-set centroid by lib/age-centroids.json.
  age_range        text not null,

  -- Average FashionCLIP embedding of the 4-8 outfit photos the user uploaded
  -- (1-2 per: casual, occasion, statement, accessories). 512-dim float array
  -- stored as JSONB for portability with the rest of the taste stack.
  upload_centroid  jsonb,

  -- Raw per-image vectors, preserved so we can rebuild the centroid later
  -- (e.g. if the category-weighting scheme changes). Up to ~8 vectors of 512
  -- floats each — small enough to keep inline.
  upload_vectors   jsonb default '[]'::jsonb,

  -- Timestamps. completed_at is a single scalar (quiz is one-shot) —
  -- updated_at tracks any future reconfigure flows.
  completed_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Gate lookups (middleware will ask "has this user completed onboarding?")
-- are by primary key, so no extra index needed.
