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
 *   PINECONE_INDEX     — your index name, e.g. "muse-products" (dim=512, metric=cosine)
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=xxx PINECONE_API_KEY=yyy PINECONE_INDEX=muse-products \
 *   node scripts/embed-products.mjs
 *
 * Flags:
 *   --resume    skip products already in checkpoint (default: auto-detected)
 *   --dry-run   embed first 50 products only (test the pipeline)
 */

import { Pinecone }          from "@pinecone-database/pinecone";
import { algoliasearch }     from "algoliasearch";
import { writeFileSync, readFileSync, existsSync } from "fs";

// ── Auto-load .env.local (command-line env vars win) ──────────────────────────

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    const v = raw.replace(/^["']|["']$/g, "");
    if (/[=\s]/.test(v)) continue;
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID    ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX    ?? "muse";
const INDEX_NAME        = "vitrine_products";
const MODEL_ID          = "Xenova/clip-vit-base-patch32";
const CHECKPOINT_FILE   = "scripts/embed-checkpoint.json";
const EMBED_BATCH       = 8;    // images embedded in parallel
const UPSERT_BATCH      = 100;  // vectors upserted to Pinecone per request
const DRY_RUN           = process.argv.includes("--dry-run");
const BRANDS_ONLY       = process.argv.includes("--brands-only");
const BRANDS_CHECKPOINT = "scripts/brands-checkpoint.json";

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

  // browseObjects iterates cursor pages automatically — no 1000-result cap
  await client.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      query:       "",
      hitsPerPage: 1000,
      attributesToRetrieve: [
        "objectID", "image_url", "category", "price_range", "retailer",
      ],
    },
    aggregator: (res) => {
      products.push(...res.hits);
      process.stdout.write(`  ${products.length} loaded…\r`);
    },
  });

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

let _debugged = false;

async function embedOne(imageUrl) {
  try {
    const { RawImage } = await import("@xenova/transformers");
    const image  = await RawImage.fromURL(imageUrl);
    const inputs = await processor(image);
    const output = await model(inputs);

    // Debug: log the full output shape on first call so we know what we're getting
    if (!_debugged) {
      _debugged = true;
      console.log("\n[debug] model output keys:", Object.keys(output));
      for (const [k, v] of Object.entries(output)) {
        console.log(`  ${k}: dims=${JSON.stringify(v?.dims)}, data.length=${v?.data?.length}`);
      }
    }

    // CLIPVisionModelWithProjection → image_embeds [1, 512]
    if (output.image_embeds?.data?.length > 0) {
      return Array.from(output.image_embeds.data);
    }

    // Fallback: last_hidden_state → take CLS token [0] → first hidden_size values
    if (output.last_hidden_state?.data?.length > 0) {
      const hiddenSize = output.last_hidden_state.dims[2];
      return Array.from(output.last_hidden_state.data.slice(0, hiddenSize));
    }

    console.error("\n[embedOne] No usable output for", imageUrl, "— keys:", Object.keys(output));
    return null;
  } catch (err) {
    console.error("\n[embedOne] Exception:", err.message, "| URL:", imageUrl.slice(0, 80));
    return null;
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

  // --brands-only: restrict to the IDs from the latest brand scrape
  if (BRANDS_ONLY) {
    if (!existsSync(BRANDS_CHECKPOINT)) {
      console.error(`--brands-only: ${BRANDS_CHECKPOINT} not found. Run scrape-brands.mjs first.`);
      process.exit(1);
    }
    const brands = JSON.parse(readFileSync(BRANDS_CHECKPOINT, "utf8"));
    const targetIds = new Set((brands.products ?? []).map((p) => p.objectID));
    const before = products.length;
    products = products.filter((p) => targetIds.has(p.objectID));
    console.log(`--brands-only: filtered ${before.toLocaleString()} → ${products.length.toLocaleString()} products (target set: ${targetIds.size.toLocaleString()})`);
  }

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

    // Embed sequentially — ONNX/WASM runtime is not safe for concurrent inference
    for (let j = 0; j < batch.length; j++) {
      const product = batch[j];
      const values  = await embedOne(product.image_url);

      // Mark failed images as done so we skip them on resume
      if (!values || values.length === 0) { failed++; done.add(product.objectID); continue; }

      upsertBuffer.push({
        id:       product.objectID,
        values,
        metadata: {
          category:    product.category    ?? "unknown",
          price_range: product.price_range ?? "mid",
          retailer:    product.retailer    ?? "",
        },
      });
      embedded++;
      // NOTE: do NOT add to done yet — only after confirmed upsert below
    }

    // Upsert when buffer is full — mark as done ONLY after Pinecone confirms
    while (upsertBuffer.length >= UPSERT_BATCH) {
      const toUpsert = upsertBuffer.splice(0, UPSERT_BATCH);
      await index.upsert({ records: toUpsert });
      for (const r of toUpsert) done.add(r.id);  // confirmed in Pinecone
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

  // Flush remaining buffer — confirm each chunk before checkpointing
  if (upsertBuffer.length > 0) {
    for (let i = 0; i < upsertBuffer.length; i += UPSERT_BATCH) {
      const chunk = upsertBuffer.slice(i, i + UPSERT_BATCH);
      if (chunk.length > 0) {
        await index.upsert({ records: chunk });
        for (const r of chunk) done.add(r.id);
      }
    }
  }

  saveCheckpoint(done);

  console.log(`\n\nDone! ${embedded} embedded, ${failed} skipped (broken images).`);
  console.log(`Pinecone index "${PINECONE_INDEX}" is ready for visual search.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
