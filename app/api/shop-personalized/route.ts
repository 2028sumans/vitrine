/**
 * POST /api/shop-personalized
 *
 * Takes a list of Pinterest pin image URLs and returns a ranked pool of
 * catalog products that match the aesthetic expressed by those pins. The
 * /shop page then interleaves this pool at 30% against the flat catalog
 * feed (it does NOT replace the feed).
 *
 * Pipeline (Claude Vision → Algolia, ~5 s total):
 *
 *   1. One Claude Haiku vision call looks at up to 10 pin images and
 *      extracts search terms + avoid terms + price tier. Haiku is used
 *      because this is a structured-extraction task, not a nuanced
 *      editorial judgement — it's ~4× faster/cheaper than Sonnet.
 *   2. Those terms become the query + optionalWords for a single Algolia
 *      search. optionalWords ranks-boost rather than hard-filters, so any
 *      term can match and matching more ranks higher.
 *   3. Brand-mode clients pass brandFilter so the pool stays inside the
 *      brand scope (otherwise the whole catalog is fair game).
 *
 * Why not FashionCLIP + Pinecone (the old implementation):
 *   The previous version embedded each pin sequentially on the Lambda CPU
 *   (~1.5 s per pin × 24 pins) and then hit Pinecone. Real-world wall
 *   time: 30–60 s on the "reading pinterest…" indicator. Claude Vision
 *   with URL inputs turns the entire step into one batched API call.
 */

import { NextResponse }  from "next/server";
import Anthropic         from "@anthropic-ai/sdk";
import { algoliasearch } from "algoliasearch";

const INDEX_NAME   = "vitrine_products";
const MAX_PINS     = 10;
const POOL_SIZE    = 150;
const CLAUDE_MODEL = "claude-haiku-4-5";

interface ClaudeAestheticOutput {
  search_terms?: string[];
  avoid_terms?:  string[];
  price_range?:  "budget" | "mid" | "luxury";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const pinImageUrls: string[] = Array.isArray(body?.pinImageUrls) ? body.pinImageUrls : [];
  const brandFilter:  string   = typeof body?.brandFilter === "string" ? body.brandFilter.trim() : "";

  if (pinImageUrls.length === 0) {
    return NextResponse.json({ products: [] });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ products: [], error: "ANTHROPIC_API_KEY missing" });
  }

  const urls = pinImageUrls.slice(0, MAX_PINS);

  try {
    // ── Step 1. Claude reads the pins, emits retrieval terms ──────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const imgBlocks = urls.map((url) => ({
      type:   "image" as const,
      source: { type: "url" as const, url },
    }));

    const prompt =
      `You are a fashion editor reading a user's Pinterest collection to learn their taste.\n\n` +
      `Look at these ${urls.length} pins. Some may not depict clothing at all (portraits, interiors, food, makeup) — skip those.\n\n` +
      `Extract SEARCH TERMS that would retrieve visually-similar pieces from a fashion catalog. Each term should be 1–3 words and concretely searchable (color + garment type, fabric + silhouette, etc). Do NOT output abstract aesthetic labels ("cottagecore", "Y2K") or invented descriptors. Do NOT output brand names.\n\n` +
      `Good examples: "cream linen", "wide-leg trouser", "slip dress", "black blazer", "leather loafers", "ribbed knit", "oversized coat", "minimalist", "vintage".\n` +
      `Bad examples: "effortless", "dusty-sage bias-cut linen slip dress", "that Parisian girl look".\n\n` +
      `Also note what is conspicuously ABSENT from the board — things the user seems to avoid.\n\n` +
      `Return ONLY valid JSON, no preamble:\n` +
      `{\n` +
      `  "search_terms": ["15–20 concrete 1–3 word terms"],\n` +
      `  "avoid_terms":  ["3–5 terms for things absent from the board"],\n` +
      `  "price_range":  "budget | mid | luxury"\n` +
      `}`;

    const message = await client.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 800,
      messages:   [{
        role:    "user",
        content: [...imgBlocks, { type: "text" as const, text: prompt }],
      }],
    });

    const rawText = message.content[0]?.type === "text" ? message.content[0].text : "";
    const json    = rawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}";

    let parsed: ClaudeAestheticOutput = {};
    try { parsed = JSON.parse(json) as ClaudeAestheticOutput; } catch {
      console.warn("[shop-personalized] Claude returned non-JSON:", rawText.slice(0, 200));
      return NextResponse.json({ products: [], error: "Claude output unparseable" });
    }

    const terms = (parsed.search_terms ?? [])
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim());
    if (terms.length === 0) {
      return NextResponse.json({ products: [], pinsUsed: urls.length });
    }

    // ── Step 2. Algolia search driven by those terms ──────────────────────
    const appId = process.env.ALGOLIA_APP_ID
      ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID
      ?? "BSDU5QFOT3";
    const key = process.env.ALGOLIA_SEARCH_KEY
      ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
      ?? process.env.ALGOLIA_ADMIN_KEY;

    if (!appId || !key) {
      return NextResponse.json({ products: [], error: "Algolia credentials missing" });
    }

    // Query string = all terms concatenated; optionalWords = split to words
    // so each individual word is a ranking hint rather than a hard filter.
    const query         = terms.join(" ");
    const optionalWords = query.split(/\s+/).filter((w) => w.length > 1);

    const brandFilterQuery = brandFilter
      ? `brand:"${brandFilter.replace(/"/g, '\\"')}" OR retailer:"${brandFilter.replace(/"/g, '\\"')}"`
      : "";

    const algoliaClient = algoliasearch(appId, key);
    const res = await algoliaClient.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query,
        optionalWords,
        ...(brandFilterQuery ? { filters: brandFilterQuery } : {}),
        hitsPerPage: POOL_SIZE,
        attributesToRetrieve: [
          "objectID", "title", "brand", "retailer", "price",
          "image_url", "product_url",
          "category", "color", "price_range",
        ],
      },
    });

    let products = (res.hits ?? []) as Array<Record<string, unknown>>;

    // ── Step 3. Post-filter avoid terms (simple title substring match) ────
    const avoid = (parsed.avoid_terms ?? [])
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 2);

    if (avoid.length > 0) {
      products = products.filter((p) => {
        const haystack =
          `${String(p.title ?? "")} ${String(p.category ?? "")} ${String(p.color ?? "")}`.toLowerCase();
        return !avoid.some((a) => haystack.includes(a));
      });
    }

    // Image-url sanity
    const clean = products.filter((p) => {
      const u = p.image_url;
      return typeof u === "string" && u.startsWith("http");
    });

    return NextResponse.json({
      products:    clean,
      pinsUsed:    urls.length,
      searchTerms: terms,
      avoidTerms:  parsed.avoid_terms ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-personalized] Claude vision path failed:", message);
    return NextResponse.json({ products: [], error: message });
  }
}
