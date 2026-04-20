/**
 * Claude Vision product enrichment — one call per product.
 *
 * Called from scripts/embed-with-qc.mjs during the batch embed pipeline.
 * Takes a product image URL and returns three things that FashionCLIP alone
 * cannot produce:
 *
 *   1. attributes — concrete categorical fields (silhouette, fabric, pattern,
 *      neckline, length, mood, aesthetic_tags). Stored in Pinecone metadata
 *      so queries can filter on them (e.g. silhouette=slip dress, fabric=silk).
 *
 *   2. style_axes — five interpretable 0..1 scalars: formality, minimalism,
 *      edge, romance, drape. Stored in Pinecone metadata so "more minimalist"
 *      becomes a numeric re-rank signal instead of a re-embed.
 *
 *   3. caption — a 15–30 word FashionCLIP-native description. This feeds a
 *      second "vibe vector" that lives in the Pinecone `vibe` namespace and
 *      gets fused with the visual vector at query time via RRF. Captions use
 *      concrete garment vocabulary (color + fabric + silhouette + details),
 *      not abstract vibe words — the point is to give FashionCLIP something
 *      it can actually encode.
 *
 * Cost: ~$0.0005 per product with claude-haiku-4-5 (image-url input).
 * At 100K products ≈ $50. Graceful-degrades to null on any failure so the
 * main visual embed path is never blocked.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL       = "claude-haiku-4-5";
const MAX_TOKENS  = 400;
const TIMEOUT_MS  = 15_000;
const MAX_RETRIES = 3;

const PROMPT = `You are a fashion cataloguer. Look at this product image and return ONE minified JSON object.

Use exactly these keys and vocabularies — no invention:

attributes (concrete, observable):
  silhouette: "slip dress" | "a-line dress" | "midi dress" | "maxi dress" | "mini dress" | "shift dress" | "wrap dress" | "cocktail dress" | "tank top" | "tee" | "blouse" | "button-down" | "knit top" | "sweater" | "cardigan" | "crop top" | "bodysuit" | "trouser" | "wide-leg pant" | "slim pant" | "jean" | "short" | "mini skirt" | "midi skirt" | "maxi skirt" | "blazer" | "jacket" | "coat" | "trench" | "puffer" | "bomber" | "flat" | "heel" | "boot" | "sneaker" | "loafer" | "sandal" | "tote" | "shoulder bag" | "crossbody" | "clutch" | "backpack" | "other"
  fabric: "silk" | "satin" | "linen" | "cotton" | "knit" | "wool" | "leather" | "denim" | "suede" | "velvet" | "tulle" | "mesh" | "chiffon" | "lace" | "nylon" | "synthetic" | "other"
  pattern: "solid" | "stripe" | "floral" | "check" | "animal" | "graphic" | "abstract" | "colorblock" | "other"
  neckline: "crew" | "v-neck" | "scoop" | "high-neck" | "halter" | "strapless" | "spaghetti" | "square" | "off-shoulder" | "collared" | "cowl" | "none"
  length: "crop" | "hip" | "mid-thigh" | "knee" | "midi" | "maxi" | "floor" | "n/a"
  mood: "polished" | "casual" | "sporty" | "romantic" | "edgy" | "dramatic" | "minimal" | "playful" | "utility"
  aesthetic_tags: 2–4 tags from exactly this list: ["minimalist","quiet luxury","old money","coastal","coquette","y2k","preppy","streetwear","grunge","romantic","boho","western","athleisure","gorpcore","avant garde","editorial","vintage"]

style_axes (each 0.0 to 1.0 — be decisive, use the full range):
  formality:  0 = sweatpants-casual, 1 = black-tie
  minimalism: 0 = maximalist/embellished, 1 = stripped-back/essential
  edge:       0 = soft/pretty, 1 = hard/subversive
  romance:    0 = strict/tailored, 1 = feminine/flowing
  drape:      0 = structured/stiff, 1 = fluid/flowing

caption: a single 15–30 word FashionCLIP-native description. Use concrete garment vocabulary — color + fabric + silhouette + key details. No abstract vibe words. Example: "cream silk slip dress with spaghetti straps and bias-cut midi length, bare shoulders, tonal styling".

Output ONLY this JSON, no preamble, no markdown:
{"attributes":{"silhouette":"","fabric":"","pattern":"","neckline":"","length":"","mood":"","aesthetic_tags":[]},"style_axes":{"formality":0,"minimalism":0,"edge":0,"romance":0,"drape":0},"caption":""}`;

/** Clamp any number to [0, 1]; coerce non-numerics to 0.5 (neutral). */
function clampAxis(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Coerce arbitrary Claude output into our metadata schema, tolerating drift. */
function normalizeEnrichment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const a = raw.attributes ?? {};
  const x = raw.style_axes ?? {};
  return {
    attributes: {
      silhouette:     typeof a.silhouette === "string" ? a.silhouette.toLowerCase() : "other",
      fabric:         typeof a.fabric     === "string" ? a.fabric.toLowerCase()     : "other",
      pattern:        typeof a.pattern    === "string" ? a.pattern.toLowerCase()    : "solid",
      neckline:       typeof a.neckline   === "string" ? a.neckline.toLowerCase()   : "none",
      length:         typeof a.length     === "string" ? a.length.toLowerCase()     : "n/a",
      mood:           typeof a.mood       === "string" ? a.mood.toLowerCase()       : "casual",
      aesthetic_tags: Array.isArray(a.aesthetic_tags)
        ? a.aesthetic_tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase()).slice(0, 4)
        : [],
    },
    style_axes: {
      formality:  clampAxis(x.formality),
      minimalism: clampAxis(x.minimalism),
      edge:       clampAxis(x.edge),
      romance:    clampAxis(x.romance),
      drape:      clampAxis(x.drape),
    },
    caption: typeof raw.caption === "string" ? raw.caption.trim().slice(0, 300) : "",
  };
}

/**
 * Enrich a single product image. Returns null on any failure so the caller
 * can proceed with the vanilla embed path. Retries transient API/timeout
 * errors with exponential backoff.
 */
export async function enrichProduct(client, imageUrl, attempt = 1) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const msg = await client.messages.create(
      {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text",  text:   PROMPT },
          ],
        }],
      },
      { signal: ctrl.signal },
    );
    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    return normalizeEnrichment(JSON.parse(json));
  } catch (e) {
    const msg = e?.message ?? "";
    // 400-class errors (bad image URL, invalid request) won't get better — bail.
    if (/400|invalid|unsupported|not an image/i.test(msg)) return null;
    if (attempt >= MAX_RETRIES) return null;
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    return enrichProduct(client, imageUrl, attempt + 1);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Flatten an enrichment result into the flat Pinecone metadata shape.
 * Pinecone only accepts string/number/boolean/string[] — no nested objects.
 */
export function enrichmentToMetadata(enr) {
  if (!enr) return {};
  return {
    silhouette:     enr.attributes.silhouette,
    fabric:         enr.attributes.fabric,
    pattern:        enr.attributes.pattern,
    neckline:       enr.attributes.neckline,
    length:         enr.attributes.length,
    mood:           enr.attributes.mood,
    aesthetic_tags: enr.attributes.aesthetic_tags,
    formality:      enr.style_axes.formality,
    minimalism:     enr.style_axes.minimalism,
    edge:           enr.style_axes.edge,
    romance:        enr.style_axes.romance,
    drape:          enr.style_axes.drape,
    caption:        enr.caption,
  };
}

export function makeAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
