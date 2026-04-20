# GitHub Actions

## `retrain-taste-head.yml`

Weekly retrain of `lib/taste-head.json` from the Supabase `curation_logs`
table. See header comment in the workflow for the full flow; this file
just lists what you need to set up once.

### Required repository secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret                      | What to paste                                                          |
| --------------------------- | ---------------------------------------------------------------------- |
| `PINECONE_API_KEY`          | Same key used in Vercel prod env                                       |
| `NEXT_PUBLIC_SUPABASE_URL`  | e.g. `https://xxxxx.supabase.co`                                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (**not** the anon key — training needs insert)  |
| `PINECONE_INDEX`            | Optional. Defaults to `muse`                                            |

The workflow pushes commits using the built-in `GITHUB_TOKEN`, which is
already scoped to this repo — no extra token needed.

### Before first run

1. Apply the migration: `supabase/migrations/20260420_curation_logs.sql`
   (either `supabase db push`, or paste into the SQL Editor).
2. Import existing local rows (one-time):
   ```
   node scripts/import-curation-log-to-supabase.mjs
   ```
3. Trigger the workflow manually from the Actions tab to prove it works:
   use **Run workflow** with `row_threshold: 0` so it runs even with a
   small delta. After the first successful run, the cron takes over.

### Tuning

- **Retrain less often**: edit the `cron` expression. `0 3 1,15 * *` is
  twice-monthly, for example.
- **Raise the bar for promotion**: pass `--promo-margin 0.03` (3 pp lift
  instead of 1 pp) in the training step.
- **Bigger held-out split on low-data runs**: `--split 0.3` for a more
  pessimistic eval when rows are scarce.
