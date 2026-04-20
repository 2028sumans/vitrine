-- Curation decision log — one row per curateProducts call. Columns mirror
-- the JSONL shape in lib/curation-log.ts so a local JSONL export can be
-- imported directly.
--
-- Written by lib/curation-log.ts (service-role insert from server routes).
-- Read by scripts/train-taste-head.mjs to build triplet training data.

create table if not exists public.curation_logs (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),

  -- Stable hash of the (primary + secondary aesthetic + summary) so
  -- training can group rows by aesthetic family.
  dna_hash            text not null,

  -- Human-readable fields — useful for inspecting the log, never used
  -- by the training loop directly.
  dna_summary         text default '',
  primary_aesthetic   text default '',
  secondary_aesthetic text default '',
  price_range         text default 'mid',

  -- The three ID sets. candidate_ids = everything shown to Claude;
  -- kept_ids is the subset Claude selected; rejected_ids is the set
  -- difference (stored explicitly for training-script convenience).
  candidate_ids       text[] not null default '{}',
  kept_ids            text[] not null default '{}',
  rejected_ids        text[] not null default '{}',

  -- Pinterest/uploaded board image URLs (up to 8) — kept so training can
  -- optionally re-embed them as query anchors later.
  board_image_urls    text[] not null default '{}'
);

-- Most common read is "give me the last N rows" — training typically
-- fetches the latest K batches plus a held-out random sample.
create index if not exists curation_logs_created_at_idx
  on public.curation_logs (created_at desc);

-- Dedup helper: if the same board is re-curated the (dna_hash + day)
-- combination is a reasonable uniqueness proxy; we don't enforce it
-- because legitimate re-curations (different context, extra pin) are
-- still useful signal.
create index if not exists curation_logs_dna_hash_idx
  on public.curation_logs (dna_hash);
