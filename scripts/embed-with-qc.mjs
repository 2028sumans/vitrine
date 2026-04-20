/**
 * Combined quality-check + FashionCLIP embed + Pinecone upsert.
 *
 * Improvements over basic CLIP:
 *   1. FashionCLIP (ff13/fashion-clip) — fine-tuned on 700K fashion image-text pairs.
 *      Better understanding of silhouettes, fabrics, cuts, and fashion-specific concepts.
 *   2. Background removal — strips model/background before embedding so visual
 *      similarity is about the garment, not the shooting environment.
 *   3. Text+image blended vectors — encodes "title brand category" alongside the image
 *      and blends 70% image + 30% text (both L2-normalized). Text-to-image queries
 *      become dramatically better because every stored vector already "knows" what
 *      the product is called, not just what it looks like.
 *
 * For each product in Algolia:
 *   1. Download image once
 *   2. Run sharp quality checks (blur, low-res, flat graphic, banner ratio)
 *   3a. PASS → remove background → embed image+text → upsert to Pinecone (stops at PINECONE_CAP)
 *   3b. FAIL → record objectID for Algolia deletion at the end
 *
 * Saves a checkpoint every 200 products — safe to kill and resume anytime.
 * At the end: batch-deletes all quality-failed products from Algolia.
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=<key> PINECONE_API_KEY=<key> node scripts/embed-with-qc.mjs
 *   Add --dry-run to process only the first 50 products (test the pipeline)
 *   Add --yes    to skip confirmation prompt
 *
 * Install background removal before first run:
 *   npm install @imgly/background-removal-node
 */

import sharp        from "sharp";
import { Pinecone } from "@pinecone-database/pinecone";
import { algoliasearch } from "algoliasearch";
import { readFileSync, writeFileSync, existsSync } from "fs";
import readline from "readline";
import { enrichProduct, enrichmentToMetadata, makeAnthropicClient } from "./enrich-product.mjs";

// ── Config ─────────────────────────────────────────────────────────────────
const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const INDEX_NAME        = "vitrine_products";

// Must match lib/embeddings.ts MODEL_ID exactly
const MODEL_ID          = "ff13/fashion-clip";

const CHECKPOINT_FILE   = "scripts/embed-qc-checkpoint.json";
const REPORT_FILE       = "scripts/embed-qc-report.json";

const PINECONE_CAP      = 100_000;
const DOWNLOAD_BATCH    = 10;      // images downloaded in parallel
const UPSERT_BATCH      = 100;     // vectors per Pinecone upsert call
const CHECKPOINT_EVERY  = 200;
const TIMEOUT_MS        = 20_000;
const MAX_BYTES         = 8 * 1024 * 1024;

// Pinecone namespace that holds the parallel "vibe vector" (FashionCLIP text
// encoding of a Claude-generated caption). See scripts/enrich-product.mjs.
const VIBE_NAMESPACE    = "vibe";
const NO_ENRICH         = process.argv.includes("--no-enrich");

// Image text blend ratio: 0.7 image + 0.3 text (both L2-normalized before blending)
const IMAGE_WEIGHT      = 0.7;
const TEXT_WEIGHT       = 0.3;

// Max images per product to embed. FashionCLIP on the hero shot alone misses
// texture, back views, and detail crops; averaging the hero + a couple of
// additional product photos tightens the visual representation considerably.
// 3 is the sweet spot — diminishing returns past that and Shopify catalogs
// rarely carry more than 4–5 photos anyway.
const IMAGES_PER_PRODUCT = 3;

// Quality thresholds
const BLUR_THRESHOLD    = 18;
const ENTROPY_THRESHOLD = 2.8;
const MIN_DIM           = 200;
const MAX_RATIO         = 3.5;

const DRY_RUN  = process.argv.includes("--dry-run");
const AUTO_YES = process.argv.includes("--yes");

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

// ── Checkpoint ─────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { done: new Set(), toDelete: [] };
  const raw = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  return { done: new Set(raw.done ?? []), toDelete: raw.toDelete ?? [] };
}

function saveCheckpoint(done, toDelete) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ done: [...done], toDelete }));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

function normalizeVec(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

function blendVectors(imageVec, textVec) {
  const ni = normalizeVec(imageVec);
  const nt = normalizeVec(textVec);
  return normalizeVec(ni.map((v, i) => IMAGE_WEIGHT * v + TEXT_WEIGHT * (nt[i] ?? 0)));
}

// ── Image download with retry ──────────────────────────────────────────────
// Sample of 100 "failed" URLs from the first run showed 100% were transient
// network noise (WiFi switches, brief DNS blips), not actually dead URLs.
// So we now retry on transient failures: ENOTFOUND, ECONNRESET, timeouts,
// HTTP 5xx. Permanent failures (404, 410, non-image content-type) still
// return null immediately — no point retrying those.
async function fetchImage(url, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Vitrine-Embed/2.0)" },
    });
    // Permanent failures — don't retry
    if (res.status >= 400 && res.status < 500) return null;
    // Transient failure — retry with backoff
    if (res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) return null;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      return fetchImage(url, attempt + 1);
    }
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null; // permanent: not an image
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null; // permanent: too big
    return Buffer.from(buf);
  } catch (e) {
    // Classify the network error: only retry on transient ones
    const code = e?.cause?.code ?? e?.code ?? "";
    const msg  = e?.message ?? "";
    const transient =
      code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
      code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "EPIPE" ||
      e?.name === "AbortError" ||
      /ENOTFOUND|getaddrinfo|fetch failed|network|timeout/i.test(msg);
    if (transient && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      return fetchImage(url, attempt + 1);
    }
    return null;
  } finally { clearTimeout(t); }
}

// (Background removal intentionally removed — caused ONNX runtime conflicts
// with FashionCLIP and stripped backgrounds didn't improve match quality.)

// ── Sharp quality check ────────────────────────────────────────────────────
async function qualityCheck(buf) {
  try {
    const meta = await sharp(buf).metadata();
    const { width = 0, height = 0 } = meta;
    if (width < MIN_DIM || height < MIN_DIM) return { pass: false, reason: "lowRes" };

    const ratio = width / height;
    if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) return { pass: false, reason: "tallBanner" };

    const resized = sharp(buf).resize(400, 400, { fit: "inside", withoutEnlargement: true });

    const { channels: lap } = await resized.clone().greyscale()
      .convolve({ width: 3, height: 3, kernel: [0,1,0,1,-4,1,0,1,0], scale: 1, offset: 128 })
      .stats();
    if (lap[0].stdev < BLUR_THRESHOLD) return { pass: false, reason: "blurry" };

    const { channels: col } = await resized.clone().removeAlpha().stats();
    const entropy = (col[0].entropy + col[1].entropy + (col[2]?.entropy ?? col[0].entropy)) / 3;
    if (entropy < ENTROPY_THRESHOLD) return { pass: false, reason: "flatGraphic" };

    return { pass: true };
  } catch { return { pass: false, reason: "sharpError" }; }
}

// ── FashionCLIP vision model ───────────────────────────────────────────────
let clipProcessor, clipModel;

async function loadVisionModel() {
  const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  env.cacheDir = "./.cache/transformers";
  console.log(`Loading FashionCLIP vision model (${MODEL_ID})…`);
  [clipProcessor, clipModel] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);
  console.log("  ✓ Vision model ready.");
}

// ── FashionCLIP text model ─────────────────────────────────────────────────
let clipTokenizer, clipTextModel;

async function loadTextModel() {
  const { env, CLIPTextModelWithProjection, AutoTokenizer } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  env.cacheDir = "./.cache/transformers";
  console.log(`Loading FashionCLIP text model (${MODEL_ID})…`);
  [clipTokenizer, clipTextModel] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID),
    CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);
  console.log("  ✓ Text model ready.");
}

// ── Embed image buffer ─────────────────────────────────────────────────────
async function embedBuffer(buf) {
  try {
    const { RawImage } = await import("@xenova/transformers");
    const image  = await RawImage.fromBlob(new Blob([buf]));
    const inputs = await clipProcessor(image);
    const output = await clipModel(inputs);
    if (output.image_embeds?.data?.length > 0) return Array.from(output.image_embeds.data);
    return null;
  } catch { return null; }
}

// ── Embed text ─────────────────────────────────────────────────────────────
async function embedText(text) {
  try {
    const inputs = await clipTokenizer(text, { padding: true, truncation: true });
    const output = await clipTextModel(inputs);
    if (output.text_embeds?.data?.length > 0) return Array.from(output.text_embeds.data);
    return null;
  } catch { return null; }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Clients
  const algolia  = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const pcIndex  = pinecone.index(PINECONE_INDEX);

  // Pinecone current count
  console.log(`Checking Pinecone index "${PINECONE_INDEX}"…`);
  const pcStats   = await pcIndex.describeIndexStats();
  const pcCurrent = pcStats.totalRecordCount ?? pcStats.totalVectorCount ?? 0;
  console.log(`  Vectors in Pinecone: ${pcCurrent.toLocaleString()} / ${PINECONE_CAP.toLocaleString()}`);
  if (pcCurrent >= PINECONE_CAP) { console.log("Pinecone cap already reached."); return; }

  // Checkpoint
  const { done, toDelete } = loadCheckpoint();
  console.log(`Checkpoint: ${done.size.toLocaleString()} done, ${toDelete.length.toLocaleString()} queued for deletion.\n`);

  // Load products from Algolia
  console.log("Loading products from Algolia…");
  const all = [];
  await algolia.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      query: "", hitsPerPage: 1000,
      attributesToRetrieve: ["objectID", "title", "brand", "image_url", "images", "category", "price_range", "retailer"],
    },
    aggregator: (res) => {
      all.push(...res.hits);
      process.stdout.write(`\r  ${all.length.toLocaleString()} loaded…`);
    },
  });
  console.log(`\nAlgolia: ${all.length.toLocaleString()} products.`);

  let products = all.filter((p) => p.image_url?.startsWith("http") && !done.has(p.objectID));
  console.log(`To process: ${products.length.toLocaleString()}\n`);

  if (DRY_RUN) { products = products.slice(0, 50); console.log("--dry-run: capped at 50.\n"); }
  if (products.length === 0) {
    if (toDelete.length > 0) await deleteFromAlgolia(algolia, toDelete);
    return;
  }

  if (!AUTO_YES) {
    const a = await ask(`Process ${products.length.toLocaleString()} products? Type "yes": `);
    if (a.trim().toLowerCase() !== "yes") { console.log("Cancelled."); return; }
  }

  // Load both CLIP models
  await loadVisionModel();
  await loadTextModel();
  console.log();

  // Claude Vision enrichment client — optional. Missing ANTHROPIC_API_KEY
  // (or --no-enrich) degrades to the vanilla visual-only path.
  const anthropic = NO_ENRICH ? null : makeAnthropicClient();
  if (anthropic) {
    console.log("Claude Vision enrichment: ON (attributes + style_axes + vibe caption)");
  } else if (NO_ENRICH) {
    console.log("Claude Vision enrichment: OFF (--no-enrich)");
  } else {
    console.log("Claude Vision enrichment: OFF (ANTHROPIC_API_KEY missing)");
  }

  // Stats
  const stats = { processed: 0, embedded: 0, qualityFailed: 0, downloadFailed: 0, embedFailed: 0, pineconeSkipped: 0, enriched: 0, enrichFailed: 0 };
  const failReasons = {};

  let pcCount   = pcCurrent;
  let upsertBuf = [];        // visual vectors → default namespace
  let vibeBuf   = [];        // vibe vectors   → "vibe" namespace
  const t0      = Date.now();

  // Retry Pinecone upserts on transient network failures (WiFi switches,
  // DNS hiccups, brief upstream outages). Up to 6 attempts with exponential
  // backoff: 2s, 4s, 8s, 16s, 32s, 60s — about 2 minutes total before failing.
  async function upsertWithRetry(records, namespace = null) {
    const transientCodes = new Set(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);
    const MAX_ATTEMPTS = 6;
    const target = namespace ? pcIndex.namespace(namespace) : pcIndex;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await target.upsert({ records });
        return;
      } catch (e) {
        const code = e?.code ?? e?.cause?.code ?? "";
        const isTransient = transientCodes.has(code) || /ENOTFOUND|getaddrinfo|fetch failed|network/i.test(e?.message ?? "");
        if (!isTransient || attempt === MAX_ATTEMPTS) throw e;
        const waitMs = Math.min(60_000, 2_000 * Math.pow(2, attempt - 1));
        process.stdout.write(`\n  ⚠ upsert ${code || "network"} error [${namespace ?? "default"}], retrying in ${waitMs/1000}s (attempt ${attempt}/${MAX_ATTEMPTS - 1})…\n`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  async function flushUpsert() {
    if (upsertBuf.length > 0) {
      const chunk = upsertBuf.splice(0, upsertBuf.length);
      await upsertWithRetry(chunk);
      for (const v of chunk) done.add(v.id);
      pcCount += chunk.length;
    }
    if (vibeBuf.length > 0) {
      const chunk = vibeBuf.splice(0, vibeBuf.length);
      await upsertWithRetry(chunk, VIBE_NAMESPACE);
    }
  }

  // Gather up to IMAGES_PER_PRODUCT URLs per product. `image_url` always leads
  // (Vitrine's scrapers make it the hero shot); `images[]` holds the extra
  // angles/details. De-dup so a product that repeats its hero inside `images`
  // doesn't double-embed the same photo.
  function pickImageUrls(p) {
    const urls = [];
    const seen = new Set();
    const add = (u) => {
      if (typeof u !== "string") return;
      if (!u.startsWith("http")) return;
      if (seen.has(u)) return;
      seen.add(u);
      urls.push(u);
    };
    add(p.image_url);
    if (Array.isArray(p.images)) for (const u of p.images) add(u);
    return urls.slice(0, IMAGES_PER_PRODUCT);
  }

  // Normalize each input vector, average, then re-normalize. Per-vector norm
  // before pooling means bigger images don't dominate the pool from having
  // larger magnitudes.
  function meanPoolVectors(vectors) {
    if (vectors.length === 0) return null;
    if (vectors.length === 1) return normalizeVec(vectors[0]);
    const D = vectors[0].length;
    const sum = new Array(D).fill(0);
    for (const v of vectors) {
      const n = normalizeVec(v);
      for (let k = 0; k < D; k++) sum[k] += n[k];
    }
    for (let k = 0; k < D; k++) sum[k] /= vectors.length;
    return normalizeVec(sum);
  }

  for (let i = 0; i < products.length; i += DOWNLOAD_BATCH) {
    const batch = products.slice(i, i + DOWNLOAD_BATCH);

    // 1. Pick image URLs per product, download them all in parallel (flat
    //    across all products in the batch so we saturate the network loop
    //    rather than waiting per-product).
    const urlsPerProduct = batch.map(pickImageUrls);
    const flatJobs = [];
    for (let j = 0; j < batch.length; j++) {
      for (const url of urlsPerProduct[j]) flatJobs.push({ j, url });
    }
    const flatBuffers = await Promise.all(flatJobs.map((job) => fetchImage(job.url)));
    const buffersPerProduct = batch.map(() => []);
    flatJobs.forEach((job, k) => { buffersPerProduct[job.j].push(flatBuffers[k]); });

    // 2. Quality-check every downloaded buffer in parallel (sharp is fast).
    //    A product passes if at least its PRIMARY (first) image is usable;
    //    the other images are optional enrichment and failures just drop them.
    const qcPerProduct = await Promise.all(
      buffersPerProduct.map((bufs) =>
        Promise.all(bufs.map((b) => (b ? qualityCheck(b) : null)))
      )
    );

    // 3. Per product: average embeddings across all passing images, sequential
    //    because the ONNX runtime used by @xenova/transformers is not thread-safe.
    for (let j = 0; j < batch.length; j++) {
      const p       = batch[j];
      const bufs    = buffersPerProduct[j];
      const qcs     = qcPerProduct[j];
      const primary = bufs[0];
      const primaryQc = qcs[0];

      if (!primary) {
        stats.downloadFailed++;
        done.add(p.objectID);
      } else if (!primaryQc?.pass) {
        stats.qualityFailed++;
        failReasons[primaryQc?.reason ?? "qcError"] = (failReasons[primaryQc?.reason ?? "qcError"] || 0) + 1;
        toDelete.push(p.objectID);
        done.add(p.objectID);
      } else if (pcCount + upsertBuf.length >= PINECONE_CAP) {
        stats.pineconeSkipped++;
        done.add(p.objectID);
      } else {
        // Kick off Claude Vision enrichment in parallel with the (sequential,
        // ONNX-bound) image embed so the network hop doesn't add wall time.
        const enrichPromise = anthropic
          ? enrichProduct(anthropic, p.image_url).catch(() => null)
          : Promise.resolve(null);

        // Embed the primary image plus any additional images that passed QC.
        // Mean-pool the resulting vectors so material/detail views contribute
        // alongside the hero. Single-image products fall through unchanged.
        const usableBuffers = [primary];
        for (let k = 1; k < bufs.length; k++) {
          if (bufs[k] && qcs[k]?.pass) usableBuffers.push(bufs[k]);
        }
        const imageVecs = [];
        for (const b of usableBuffers) {
          const v = await embedBuffer(b);
          if (v) imageVecs.push(v);
        }
        if (imageVecs.length === 0) { stats.embedFailed++; done.add(p.objectID); continue; }
        const imageVec = meanPoolVectors(imageVecs);
        stats.imagesEmbedded = (stats.imagesEmbedded ?? 0) + imageVecs.length;
        stats.multiImage     = (stats.multiImage     ?? 0) + (imageVecs.length > 1 ? 1 : 0);

        // Embed text: "title brand category"
        const textStr = [p.title, p.brand, p.category].filter(Boolean).join(" ");
        const textVec = await embedText(textStr);

        // Blend: 70% image + 30% text (both normalized)
        const finalVec = textVec ? blendVectors(imageVec, textVec) : normalizeVec(imageVec);

        // Collect enrichment — attrs/axes go into metadata; the caption feeds
        // a parallel "vibe vector" in the `vibe` Pinecone namespace.
        const enrichment = await enrichPromise;
        const styleMeta  = enrichmentToMetadata(enrichment);
        if (enrichment) stats.enriched++;
        else if (anthropic) stats.enrichFailed++;

        const baseMetadata = {
          brand:       p.brand       ?? "",
          category:    p.category    ?? "unknown",
          price_range: p.price_range ?? "mid",
          retailer:    p.retailer    ?? "",
          ...styleMeta,
        };

        upsertBuf.push({ id: p.objectID, values: finalVec, metadata: baseMetadata });

        // Vibe vector: FashionCLIP-text-encode the caption so it lives in the
        // same 512-dim space as the image vectors. Uses the text encoder
        // that's already loaded — no new model dependency.
        if (enrichment?.caption) {
          const captionVec = await embedText(enrichment.caption);
          if (captionVec) {
            vibeBuf.push({
              id: p.objectID,
              values: normalizeVec(captionVec),
              metadata: baseMetadata,
            });
          }
        }
        stats.embedded++;
      }

      stats.processed++;
    }

    // Upsert when buffer is full
    while (upsertBuf.length >= UPSERT_BATCH) {
      const chunk = upsertBuf.splice(0, UPSERT_BATCH);
      await upsertWithRetry(chunk);
      for (const v of chunk) done.add(v.id);
      pcCount += chunk.length;
    }
    while (vibeBuf.length >= UPSERT_BATCH) {
      const chunk = vibeBuf.splice(0, UPSERT_BATCH);
      await upsertWithRetry(chunk, VIBE_NAMESPACE);
    }

    // Checkpoint every N products
    if (stats.processed % CHECKPOINT_EVERY < DOWNLOAD_BATCH) {
      saveCheckpoint(done, toDelete);
      writeReport(stats, failReasons, toDelete);
    }

    // Progress
    const elapsed = (Date.now() - t0) / 1000;
    const rate    = stats.processed / elapsed;
    const eta     = rate > 0 ? Math.round((products.length - stats.processed) / rate / 60) : "?";
    process.stdout.write(
      `\r  ${stats.processed.toLocaleString()}/${products.length.toLocaleString()}` +
      `  embedded=${stats.embedded.toLocaleString()}` +
      `  qc_fail=${stats.qualityFailed}` +
      `  pinecone=${pcCount.toLocaleString()}/${PINECONE_CAP.toLocaleString()}` +
      `  ETA=${eta}min   `
    );

    if (pcCount >= PINECONE_CAP) {
      console.log("\n\nPinecone cap reached — stopping embed.");
      break;
    }
  }

  await flushUpsert();
  saveCheckpoint(done, toDelete);
  writeReport(stats, failReasons, toDelete);

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n\nDone in ${elapsed}min.\n`);
  console.log("Summary:");
  console.log(`  Embedded to Pinecone:  ${stats.embedded.toLocaleString().padStart(8)}`);
  console.log(`  Multi-image averaged:  ${(stats.multiImage ?? 0).toLocaleString().padStart(8)}`);
  console.log(`  Total images embedded: ${(stats.imagesEmbedded ?? 0).toLocaleString().padStart(8)}`);
  console.log(`  Claude enriched:       ${stats.enriched.toLocaleString().padStart(8)}`);
  console.log(`  Enrichment failed:     ${stats.enrichFailed.toLocaleString().padStart(8)}`);
  console.log(`  Quality failed:        ${stats.qualityFailed.toLocaleString().padStart(8)}`);
  Object.entries(failReasons).forEach(([r, n]) => n && console.log(`    ${r.padEnd(14)} ${String(n).padStart(6)}`));
  console.log(`  Download failed:       ${stats.downloadFailed.toLocaleString().padStart(8)}`);
  console.log(`  Pinecone full/skipped: ${stats.pineconeSkipped.toLocaleString().padStart(8)}`);
  console.log(`  Pinecone total now:    ${pcCount.toLocaleString().padStart(8)}`);

  if (toDelete.length > 0 && !DRY_RUN) {
    console.log(`\nDeleting ${toDelete.length.toLocaleString()} quality-failed products from Algolia…`);
    await deleteFromAlgolia(algolia, toDelete);
  } else if (DRY_RUN && toDelete.length > 0) {
    console.log(`\n--dry-run: would delete ${toDelete.length} from Algolia.`);
  }
}

function writeReport(stats, failReasons, toDelete) {
  writeFileSync(REPORT_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(), stats, failReasons, toDeleteCount: toDelete.length,
  }, null, 2));
}

async function deleteFromAlgolia(algolia, ids) {
  const BATCH = 1000;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await algolia.deleteObjects({ indexName: "vitrine_products", objectIDs: batch });
    done += batch.length;
    process.stdout.write(`\r  Deleted ${done.toLocaleString()}/${ids.length.toLocaleString()} from Algolia`);
  }
  console.log(`\n✓ Deleted ${done.toLocaleString()} records.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
