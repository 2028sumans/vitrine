/**
 * Re-embed a specific list of product IDs into Pinecone.
 *
 * Use case: an image URL was wrong (e.g. cropped social-card preview), the
 * Algolia record's been patched with the correct URL, and now the existing
 * Pinecone vector is stale and needs replacing. Targets only the IDs in the
 * input file — does not scan the full catalog.
 *
 * Run:
 *   PINECONE_API_KEY=... node scripts/reembed-from-ids.mjs scripts/nour-hammour-fixed-ids.json
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { algoliasearch } from "algoliasearch";
import { readFileSync, existsSync } from "fs";
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
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const INDEX_NAME        = "vitrine_products";
const MODEL_ID          = "Xenova/clip-vit-base-patch32";

const idsFile = process.argv[2];
if (!idsFile)       { console.error("Usage: node scripts/reembed-from-ids.mjs <ids-file.json>"); process.exit(1); }
if (!existsSync(idsFile)) { console.error(`Missing ${idsFile}`); process.exit(1); }
if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

const ids = JSON.parse(readFileSync(idsFile, "utf8"));
console.log(`Re-embedding ${ids.length} products from ${idsFile}.`);

// ── CLIP ──────────────────────────────────────────────────────────────────────

let processor, model;
async function loadModel() {
  const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  env.cacheDir = "./.cache/transformers";
  console.log(`Loading ${MODEL_ID}…`);
  [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);
  console.log("Model ready.");
}

async function embedOne(imageUrl) {
  try {
    const { RawImage } = await import("@xenova/transformers");
    const image  = await RawImage.fromURL(imageUrl);
    const inputs = await processor(image);
    const output = await model(inputs);
    if (output.image_embeds?.data?.length > 0) return Array.from(output.image_embeds.data);
    if (output.last_hidden_state?.data?.length > 0) {
      const hiddenSize = output.last_hidden_state.dims[2];
      return Array.from(output.last_hidden_state.data.slice(0, hiddenSize));
    }
    return null;
  } catch (err) {
    console.error(`\n  embed failed for ${imageUrl.slice(0, 80)}: ${err.message}`);
    return null;
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  // Fetch fresh records from Algolia so we use the (already-patched) image URLs.
  const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  console.log("Fetching latest records from Algolia…");
  const records = [];
  // getObjects supports up to 1000 per call — chunk if larger.
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const res = await algolia.getObjects({
      requests: chunk.map((objectID) => ({
        indexName: INDEX_NAME,
        objectID,
        attributesToRetrieve: ["objectID", "image_url", "category", "price_range", "retailer"],
      })),
    });
    for (const r of res.results) if (r) records.push(r);
  }
  console.log(`Got ${records.length}/${ids.length} from Algolia.`);

  await loadModel();

  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index    = pinecone.index(PINECONE_INDEX);

  const vectors = [];
  let failed = 0;
  for (let i = 0; i < records.length; i++) {
    const p = records[i];
    process.stdout.write(`\r  [${i + 1}/${records.length}] ${p.objectID.slice(0, 60).padEnd(60)}`);
    const values = await embedOne(p.image_url);
    if (!values) { failed++; continue; }
    vectors.push({
      id:       p.objectID,
      values,
      metadata: {
        category:    p.category    ?? "unknown",
        price_range: p.price_range ?? "mid",
        retailer:    p.retailer    ?? "",
      },
    });
  }
  console.log(`\n${vectors.length} embedded, ${failed} failed.`);

  if (vectors.length === 0) { console.log("Nothing to upsert."); return; }

  console.log(`Upserting to Pinecone "${PINECONE_INDEX}"…`);
  for (let i = 0; i < vectors.length; i += 100) {
    const chunk = vectors.slice(i, i + 100);
    await index.upsert({ records: chunk });
  }
  console.log(`✓ Upserted ${vectors.length} vectors.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
