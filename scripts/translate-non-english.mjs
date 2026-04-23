/**
 * Detect non-English product titles/descriptions in Algolia and back-fill
 * English translations as `title_en`, `description_en`, plus an
 * `original_language` field. Outbound brand links still go to the native-
 * language site — only the in-app surface reads English.
 *
 * Why this exists: scrapers pull title/description verbatim from each brand's
 * site. Brands that publish in French (Antik Batik, Ava Be), German (Manuka
 * Global), Portuguese (Odaje), Spanish, Italian etc. land in Algolia in
 * their source language. For an English-speaking user the search and tile
 * copy is unreadable.
 *
 * Pipeline:
 *   1. Browse the catalog from Algolia (or resume from checkpoint).
 *   2. Cheap pre-filter: skip records whose text already looks English
 *      (mostly-ASCII + multiple common English words). Cuts Haiku spend by
 *      roughly 70-80% on a typical mixed catalog.
 *   3. Batch the rest (~30 products per call) → Claude Haiku → returns
 *      {objectID, language, title_en, description_en} for each.
 *   4. partialUpdateObjects in Algolia. The original `title` / `description`
 *      stay untouched so we can re-translate later if we want.
 *   5. Checkpoint every batch so a crash resumes.
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=… ANTHROPIC_API_KEY=… node scripts/translate-non-english.mjs
 *
 * Flags:
 *   --dry-run       scan + classify, but don't call Haiku and don't write
 *   --limit=N       cap candidates processed (testing)
 *   --batch=N       products per Haiku call (default 30)
 *   --resume        skip objectIDs already in the checkpoint
 */

import { algoliasearch } from "algoliasearch";
import Anthropic         from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const INDEX_NAME        = "vitrine_products";
const CHECKPOINT_FILE   = "scripts/translate-checkpoint.json";

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const RESUME   = args.includes("--resume");
const LIMIT    = parseInt(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? "0", 10);
const BATCH    = parseInt(args.find((a) => a.startsWith("--batch="))?.slice(8) ?? "30", 10);

if (!DRY_RUN && !ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY (required unless --dry-run)");
  process.exit(1);
}

// ── Pre-filter: looks like English? ───────────────────────────────────────────
// Cheap heuristic to skip Haiku calls on the obvious cases. Two signals:
//   1. Mostly ASCII (a French sentence has lots of accents; an English one
//      doesn't). Threshold > 0.97 (allows the occasional brand mark or em-dash).
//   2. Multiple common English function words OR English fashion vocabulary.
//      Real English product copy almost always has 3+ of these.
// If both fire → assume English, skip Haiku. False negatives are fine: those
// will go through Haiku and Haiku will say `language: "english"`, no harm.

const ENGLISH_WORDS = new RegExp(
  "\\b(the|and|with|for|this|from|in|of|to|on|by|that|our|your|all|is|are|was|were|" +
  // fashion vocabulary
  "cotton|leather|silk|wool|linen|cashmere|denim|knit|jersey|fabric|tweed|satin|velvet|chiffon|lace|" +
  "black|white|cream|navy|beige|red|blue|green|brown|pink|gold|silver|tan|grey|gray|olive|sage|ivory|" +
  // garments — covers most short titles like "Lula Bikini Bottom"
  "dress|shirt|skirt|pant|pants|trouser|jean|jacket|coat|blazer|top|blouse|cardigan|sweater|hoodie|" +
  "tee|tank|cami|bralette|bra|polo|henley|jumper|gown|romper|jumpsuit|bodysuit|" +
  "bikini|swimsuit|swim|set|suit|two[-\\s]?piece|one[-\\s]?piece|cover|" +
  "bag|tote|clutch|crossbody|shoulder|backpack|wallet|" +
  "shoe|boot|sandal|heel|flat|loafer|sneaker|mule|pump|" +
  "mini|midi|maxi|short|long|cropped|oversized|fitted|" +
  "bottom|brief|thong|sleeve|collar|hem|button|fit|cut|wear|made|" +
  "size|color|colour|length|style|design|new|sale|final)\\b",
  "ig",
);

function asciiRatio(s) {
  if (!s) return 1;
  let ascii = 0;
  for (const ch of s) if (ch.charCodeAt(0) < 128) ascii++;
  return ascii / s.length;
}

function looksEnglish(title, description) {
  const text = `${title ?? ""} ${(description ?? "").slice(0, 400)}`;
  if (!text.trim()) return true;                   // empty → no work to do
  if (asciiRatio(text) < 0.97) return false;       // accents → probably not English

  const matches = (text.match(ENGLISH_WORDS) ?? []).length;
  if (matches >= 3) return true;

  // Short titles with no description — common pattern, e.g.
  // "Lula Bikini Bottom" (3 words, all English). Accept if at least HALF the
  // tokens hit the English vocabulary; the only realistic false-positive is
  // a 2-3 word non-English title with one accidentally-English word, which
  // Haiku would have caught anyway.
  if ((description ?? "").length < 30) {
    const tokens = (title ?? "").split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && matches / tokens.length >= 0.5) return true;
  }
  return false;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8")).done ?? []);
  } catch {
    return new Set();
  }
}

function saveCheckpoint(done) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ done: [...done] }));
}

// ── Haiku batch translator ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You translate fashion product copy into English. " +
  "Input is a JSON array of products with {objectID, title, description}. " +
  "For each product, detect the source language and translate to natural English. " +
  "Preserve brand names, model names, and proper nouns verbatim — do NOT translate names. " +
  "Keep the translation concise; do not add commentary. " +
  "Return ONLY a JSON array of the form " +
  '[{"objectID":"...","language":"french|german|portuguese|spanish|italian|english|other","title_en":"...","description_en":"..."}, ...]. ' +
  "If a product is already English, set language to \"english\" and copy the title/description verbatim into title_en/description_en. " +
  "If description is empty, set description_en to empty string.";

async function translateBatch(client, items) {
  const userJson = JSON.stringify(
    items.map((p) => ({
      objectID:    p.objectID,
      title:       (p.title       ?? "").slice(0, 280),
      description: (p.description ?? "").slice(0, 600),
    })),
  );

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 4000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: "user", content: userJson }],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  // Be tolerant of code-fence wrappers Haiku occasionally adds.
  const json = text.match(/\[[\s\S]*\]/)?.[0] ?? "[]";
  return JSON.parse(json);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  console.log("1. Browsing Algolia for candidates…");
  const candidates = [];
  await algolia.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      query: "",
      hitsPerPage: 1000,
      attributesToRetrieve: ["objectID", "title", "description", "title_en", "language"],
    },
    aggregator: (r) => {
      for (const h of r.hits) {
        if (h.title_en) continue;                  // already translated
        if (looksEnglish(h.title, h.description)) continue;
        candidates.push(h);
      }
    },
  });
  console.log(`   ${candidates.length.toLocaleString()} candidates after pre-filter.`);

  let work = candidates;
  if (RESUME) {
    const done = loadCheckpoint();
    work = work.filter((p) => !done.has(p.objectID));
    console.log(`   --resume: ${work.length} remaining (${done.size} already done).`);
  }
  if (LIMIT > 0) {
    work = work.slice(0, LIMIT);
    console.log(`   --limit=${LIMIT}: ${work.length} to process.`);
  }
  if (work.length === 0) { console.log("Nothing to do."); return; }

  if (DRY_RUN) {
    console.log("\n--dry-run: sample of 5 candidates:");
    for (const p of work.slice(0, 5)) {
      console.log(`  ${p.objectID}  |  ${(p.title ?? "").slice(0, 80)}`);
    }
    console.log("\nDry-run complete. Re-run without --dry-run to process.");
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const done = RESUME ? loadCheckpoint() : new Set();
  let updated = 0;
  let englishOnly = 0;
  let failed = 0;

  for (let i = 0; i < work.length; i += BATCH) {
    const chunk = work.slice(i, i + BATCH);
    let translated;
    try {
      translated = await translateBatch(anthropic, chunk);
    } catch (e) {
      failed += chunk.length;
      console.warn(`\n  batch ${i}: ${e.message}`);
      continue;
    }

    // partialUpdateObjects in Algolia — only rows that came back non-English.
    const updates = [];
    for (const t of translated) {
      done.add(t.objectID);
      if (!t.objectID || !t.title_en) continue;
      if ((t.language ?? "").toLowerCase() === "english") { englishOnly++; continue; }
      updates.push({
        objectID:          t.objectID,
        title_en:          t.title_en,
        description_en:    t.description_en ?? "",
        original_language: t.language ?? "unknown",
      });
    }
    if (updates.length > 0) {
      try {
        await algolia.partialUpdateObjects({ indexName: INDEX_NAME, objects: updates });
        updated += updates.length;
      } catch (e) {
        console.warn(`\n  algolia partial-update failed at batch ${i}: ${e.message}`);
      }
    }

    // Checkpoint every batch — cheap and resumable.
    saveCheckpoint(done);
    process.stdout.write(`\r  ${i + chunk.length}/${work.length}  updated=${updated}  english=${englishOnly}  failed=${failed}`);
  }
  console.log(`\n\nDone. ${updated} translated, ${englishOnly} were actually English, ${failed} failures.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
