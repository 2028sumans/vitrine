/**
 * MUSE — Product Embedding Script
 *
 * Embeds all Algolia product images using CLIP (free, no API key),
 * then upserts vectors to Pinecone (free tier, 100K vectors).
 *
 * Run ONCE locally — takes ~2-4hrs for 37K products on CPU.
 * Saves a checkpoint every 500 products so you can resume if interrupted.
 *
 * Required env vars:
 *   ALGOLIA_APP_ID     — already in .env.local
 *   ALGOLIA_ADMIN_KEY  — from Algolia dashboard
 *   PINECONE_API_KEY   — from pinecone.io (free account, no credit card)
 *   PINECONE_INDEX     — your index name, e.g. "vitrine-products" (dim=512, metric=cosine)
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=xxx PINECONE_API_KEY=yyy PINECONE_INDEX=vitrine-products \
 *   node scripts/embed-products.mjs
 *
 * Flags:
 *   --resume    skip products already in checkpoint (default: auto-detected)
 *   --dry-run   embed first 50 products only (test the pipeline)
 */

import { Pinecone }          from "@pinecone-database/pinecone";
import { algoliasearch }     from "algoliasearch";
import { writeFileSync, readFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID    ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX    ?? "vitrine-products";
const INDEX_NAME        = "vitrine_products";
const MODEL_ID          = "Xenova/clip-vit-base-patch32";
const CHECKPOINT_FILE   = "scripts/embed-checkpoint.json";
const EMBED_BATCH       = 8;    // images embedded in parallel
const UPSERT_BATCH      = 100;  // vectors upserted to Pinecone per request
const DRY_RUN           = process.argv.includes("--dry-run");

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

// ── Load checkpoint ───────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return new Set();
  const { done } = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  return new Set(done);
}

function saveCheckpoint(done) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ done: [...done] }));
}

// ── Load all products from Algolia ────────────────────────────────────────────

async function loadAllProducts(client) {
  console.log("Loading products from Algolia…");
  const products = [];
  let page = 0;

  while (true) {
    const res = await client.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query:       "",
        hitsPerPage: 1000,
        page,
        attributesToRetrieve: [
          "objectID", "image_url", "category", "price_range", "retailer",
        ],
      },
    });

    products.push(...res.hits);
    if (res.hits.length < 1000) break;
    page++;
    process.stdout.write(`  ${products.length} loaded…\r`);
  }

  // Only keep products with a real image URL
  const withImages = products.filter(
    (p) => p.image_url?.startsWith("http") && !p.image_url.includes("placeholder")
  );

  console.log(`\nLoaded ${products.length} total, ${withImages.length} with images.`);
  return withImages;
}

// ── CLIP embedding ────────────────────────────────────────────────────────────

let processor, model;

async function loadModel() {
  const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  env.cacheDir = "./.cache/transformers";

  console.log(`Loading model ${MODEL_ID}… (downloads ~80MB on first run)`);
  [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);
  console.log("Model ready.");
}

async function embedOne(imageUrl) {
  const { RawImage } = await import("@xenova/transformers");
  try {
    const image = await RawImage.fromURL(imageUrl);
    const inputs = await processor(image);
    const { image_embeds } = await model(inputs);
    return Array.from(image_embeds.data); // Float32Array → plain array, length 512
  } catch {
    return null; // broken image — skip
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Clients
  const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pinecone.index(PINECONE_INDEX);

  // Load checkpoint
  const done = loadCheckpoint();
  console.log(`Checkpoint: ${done.size} products already embedded.`);

  // Load products
  let products = await loadAllProducts(algolia);
  if (DRY_RUN) { products = products.slice(0, 50); console.log("DRY RUN: capped at 50 products."); }

  // Filter already-done
  const remaining = products.filter((p) => !done.has(p.objectID));
  console.log(`${remaining.length} products to embed.`);
  if (remaining.length === 0) { console.log("All done!"); return; }

  // Load model
  await loadModel();

  // Process in batches
  let embedded = 0;
  let failed   = 0;
  const upsertBuffer = [];
  const startTime = Date.now();

  for (let i = 0; i < remaining.length; i += EMBED_BATCH) {
    const batch = remaining.slice(i, i + EMBED_BATCH);

    // Embed all images in this batch concurrently
    const embeddings = await Promise.all(batch.map((p) => embedOne(p.image_url)));

    for (let j = 0; j < batch.length; j++) {
      const product = batch[j];
      const values  = embeddings[j];

      if (!values) { failed++; done.add(product.objectID); continue; }

      upsertBuffer.push({
        id:       product.objectID,
        values,
        metadata: {
          category:    product.category    ?? "unknown",
          price_range: product.price_range ?? "mid",
          retailer:    product.retailer    ?? "",
        },
      });
      done.add(product.objectID);
      embedded++;
    }

    // Upsert when buffer is full
    while (upsertBuffer.length >= UPSERT_BATCH) {
      const toUpsert = upsertBuffer.splice(0, UPSERT_BATCH);
      await index.upsert(toUpsert);
    }

    // Progress
    const elapsed = (Date.now() - startTime) / 1000;
    const rate    = embedded / elapsed;
    const eta     = rate > 0 ? Math.round((remaining.length - i - EMBED_BATCH) / rate / 60) : "?";
    process.stdout.write(
      `  ${embedded} embedded, ${failed} failed | ${rate.toFixed(1)}/s | ETA ${eta}min   \r`
    );

    // Checkpoint every 500 products
    if ((i + EMBED_BATCH) % 500 === 0) saveCheckpoint(done);
  }

  // Flush remaining buffer
  for (let i = 0; i < upsertBuffer.length; i += UPSERT_BATCH) {
    await index.upsert(upsertBuffer.slice(i, i + UPSERT_BATCH));
  }

  saveCheckpoint(done);

  console.log(`\n\nDone! ${embedded} embedded, ${failed} skipped (broken images).`);
  console.log(`Pinecone index "${PINECONE_INDEX}" is ready for visual search.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
