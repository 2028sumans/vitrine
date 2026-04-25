/**
 * GET /api/debug/clip
 *
 * Health check for the FashionCLIP integration. Returns whether the model
 * actually loads in production, whether text encoding produces real vectors
 * (not zero/constant), and whether Pinecone responds with neighbours for
 * those vectors.
 *
 * Why: the system fails silently. If `getTextModel()` errors (network blip,
 * /tmp quota, ONNX runtime mismatch), `embedTextQuery` returns `[]`,
 * `searchByTextQuery` returns `[]`, and the pipeline degrades to Algolia-
 * only. The user sees keyword-only results without knowing CLIP isn't
 * contributing. This endpoint surfaces that state in 30 seconds.
 *
 * Hit it from a browser after a deploy, or from the Vercel dashboard's
 * runtime logs view alongside any /shop request you suspect went off-rails.
 *
 * Returns 200 always — the body's `summary.healthy` field is the
 * pass/fail. Non-200 would just mean the route handler itself crashed
 * before it could report.
 */
import { NextResponse } from "next/server";
import { embedTextQuery, searchByEmbeddings } from "@/lib/embeddings";

export const dynamic  = "force-dynamic";
export const runtime  = "nodejs";

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function vectorNorm(v: number[]): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}

export async function GET() {
  const wallStart = Date.now();
  const checks:    Record<string, unknown> = {};
  const failures:  string[] = [];

  // ── -1. onnxruntime-node loadability check ────────────────────────────────
  //        @xenova/transformers v2 picks the ONNX backend at first import:
  //        it tries onnxruntime-node, falls back to onnxruntime-web on error.
  //        The user's prod logs show transformers still using onnxruntime-web,
  //        meaning the node binding's import or runtime check failed silently.
  //        This step imports onnxruntime-node directly and reports what
  //        actually happens — distinguishing 'package not deployed' from
  //        'binary loaded but rejected' from 'module loaded but constructing
  //        a session throws'.
  try {
    const t0 = Date.now();
    const ortNode = await import("onnxruntime-node");
    const importMs = Date.now() - t0;
    const exports = Object.keys(ortNode).filter((k) => !k.startsWith("_")).slice(0, 12);

    let sessionTest: Record<string, unknown> = { skipped: "no test model file available" };
    // We don't bundle a tiny ONNX model to test session creation, but we
    // can probe whether InferenceSession is constructable and whether
    // backends.length > 0 (the runtime registers backends on first use).
    try {
      const ISClass = (ortNode as unknown as { InferenceSession?: unknown }).InferenceSession;
      const env     = (ortNode as unknown as { env?: { backends?: unknown; logLevel?: unknown } }).env;
      sessionTest = {
        InferenceSession_present: typeof ISClass === "function" || typeof ISClass === "object",
        env_present:              !!env,
        backends_registered:      env?.backends ? Object.keys(env.backends as object).length : 0,
        backends_keys:            env?.backends ? Object.keys(env.backends as object) : [],
      };
    } catch (e) {
      sessionTest = { error: e instanceof Error ? e.message : String(e) };
    }

    checks.onnxruntime_node = {
      ok:           true,
      duration_ms:  importMs,
      exports_seen: exports,
      session_test: sessionTest,
      interpretation:
        "OK — package loaded. If transformers still picks onnxruntime-web, the issue is transformers' backend selection, not our deploy.",
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    checks.onnxruntime_node = {
      ok:    false,
      error: err.message,
      name:  err.name,
      stack: err.stack?.split("\n").slice(0, 8),
      hint:
        err.message.includes("Cannot find module") || err.message.includes("ENOENT")
          ? "Native .node binary or supporting files weren't traced into the function. Check outputFileTracingIncludes covers ./node_modules/onnxruntime-node/**."
          : err.message.includes("invalid ELF") || err.message.includes("not a dynamic")
            ? "Wrong architecture for the native binary. Vercel's Lambda is linux x64."
            : err.message.includes("GLIBC")
              ? "GLIBC version mismatch — the native binary expects a newer libc than the Lambda has."
              : "Read the stack — top frame names the failing module.",
    };
    failures.push(`onnxruntime-node import failed: ${err.message}`);
  }

  // ── 0. Direct import + model load — captures the actual exception that
  //       getTextModel() swallows with `console.error + return null`. If
  //       embedTextQuery is returning [], it's because one of these threw.
  //       We unwrap the failure here so the JSON response shows it.
  try {
    const t0 = Date.now();
    const transformers = await import(/* webpackIgnore: true */ "@xenova/transformers");
    const importMs = Date.now() - t0;

    const exports = Object.keys(transformers).filter((k) => !k.startsWith("_")).slice(0, 12);
    checks.import_transformers = {
      ok:           true,
      duration_ms:  importMs,
      exports_seen: exports,
    };

    // Try to actually instantiate the tokenizer + text model.
    try {
      const { env, AutoTokenizer, CLIPTextModelWithProjection } = transformers;
      env.allowLocalModels = false;
      env.cacheDir = process.env.VERCEL ? "/tmp/transformers" : "./.cache/transformers";

      const t1 = Date.now();
      const tokenizer = await AutoTokenizer.from_pretrained("ff13/fashion-clip");
      const tokenizerMs = Date.now() - t1;
      checks.tokenizer_load = {
        ok:          !!tokenizer,
        duration_ms: tokenizerMs,
      };

      const t2 = Date.now();
      const model = await CLIPTextModelWithProjection.from_pretrained(
        "ff13/fashion-clip",
        { quantized: true },
      );
      const modelMs = Date.now() - t2;
      checks.text_model_load = {
        ok:          !!model,
        duration_ms: modelMs,
      };
      if (!model) failures.push("text_model_load returned null/undefined");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      checks.tokenizer_or_model_load = {
        ok:    false,
        error: err.message,
        name:  err.name,
        stack: err.stack?.split("\n").slice(0, 8),
      };
      failures.push(`model load threw: ${err.message}`);
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    checks.import_transformers = {
      ok:    false,
      error: err.message,
      name:  err.name,
      stack: err.stack?.split("\n").slice(0, 8),
      hint:
        err.message.includes("Cannot find module")
          ? "Package isn't in the function bundle. Check next.config.js → experimental.serverComponentsExternalPackages includes '@xenova/transformers' AND 'onnxruntime-node'."
          : err.message.includes("ENOENT") || err.message.includes("not found")
            ? "A dependency file is missing. Likely the ONNX runtime native binary wasn't traced into the deployment."
            : "Read the stack — top frame names the failing module.",
    };
    failures.push(`import @xenova/transformers threw: ${err.message}`);
  }

  // ── 1. Text encode "black slip dress" ──────────────────────────────────────
  let baselineEmb: number[] = [];
  try {
    const t0 = Date.now();
    baselineEmb = await embedTextQuery("black slip dress");
    const dt = Date.now() - t0;
    checks.text_encode_baseline = {
      ok:            baselineEmb.length > 0,
      duration_ms:   dt,
      vector_dim:    baselineEmb.length,
      norm:          baselineEmb.length > 0 ? vectorNorm(baselineEmb) : null,
      first_5:       baselineEmb.slice(0, 5),
      interpretation:
        baselineEmb.length === 0
          ? "FAIL — model returned empty vector. Check /tmp quota, region, ONNX runtime."
          : Math.abs(vectorNorm(baselineEmb) - 1) > 0.01
            ? "WARN — vector is not unit-length, downstream cosine math will misbehave."
            : "OK",
    };
    if (baselineEmb.length === 0) failures.push("text_encode_baseline returned empty");
  } catch (e) {
    checks.text_encode_baseline = {
      ok:    false,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6) : undefined,
    };
    failures.push(`text_encode_baseline threw: ${e instanceof Error ? e.message : e}`);
  }

  // ── 2. Text encode "y2k party" — the actual failing query ──────────────────
  let y2kEmb: number[] = [];
  try {
    const t0 = Date.now();
    y2kEmb = await embedTextQuery("y2k party");
    const dt = Date.now() - t0;
    checks.text_encode_y2k = {
      ok:          y2kEmb.length > 0,
      duration_ms: dt,
      vector_dim:  y2kEmb.length,
      first_5:     y2kEmb.slice(0, 5),
    };
    if (y2kEmb.length === 0) failures.push("text_encode_y2k returned empty");
  } catch (e) {
    checks.text_encode_y2k = {
      ok:    false,
      error: e instanceof Error ? e.message : String(e),
    };
    failures.push(`text_encode_y2k threw: ${e instanceof Error ? e.message : e}`);
  }

  // ── 3. Cosine between two distinct queries ────────────────────────────────
  // If the encoder is broken-but-loading (e.g. always returns the same constant
  // vector), distinct phrases will collapse to cosine ≈ 1.0. A healthy
  // FashionCLIP should put "black slip dress" and "y2k party" at cosine
  // somewhere in 0.5–0.85 — related (both fashion) but not identical.
  if (baselineEmb.length > 0 && y2kEmb.length > 0) {
    const sim = cosine(baselineEmb, y2kEmb);
    checks.distinctness = {
      ok:               sim < 0.97,
      cosine_similarity: Number(sim.toFixed(4)),
      interpretation:
        sim > 0.97
          ? "FAIL — distinct phrases produced near-identical vectors. Encoder is broken."
          : sim < 0.10
            ? "WARN — distinct phrases produced near-orthogonal vectors. Encoder may be returning noise."
            : "OK — encoder produces meaningfully distinct vectors for distinct phrases.",
    };
    if (sim > 0.97) failures.push(`distinctness FAIL: cosine=${sim.toFixed(4)} (encoder broken)`);
  } else {
    checks.distinctness = { ok: false, reason: "skipped — at least one encoding returned empty" };
  }

  // ── 4. Pinecone search with the y2k vector ────────────────────────────────
  if (y2kEmb.length > 0) {
    try {
      const t0 = Date.now();
      const ids = await searchByEmbeddings([y2kEmb], 10);
      const dt = Date.now() - t0;
      checks.pinecone_search = {
        ok:           ids.length > 0,
        duration_ms:  dt,
        ids_returned: ids.length,
        first_ids:    ids.slice(0, 5),
        interpretation:
          ids.length === 0
            ? "FAIL — Pinecone returned no neighbours. Index may be empty or wrong namespace."
            : "OK",
      };
      if (ids.length === 0) failures.push("pinecone_search returned 0 ids");
    } catch (e) {
      checks.pinecone_search = {
        ok:    false,
        error: e instanceof Error ? e.message : String(e),
      };
      failures.push(`pinecone_search threw: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    checks.pinecone_search = { ok: false, reason: "skipped — y2k embedding empty" };
  }

  // ── 5. Memory snapshot ────────────────────────────────────────────────────
  // Vercel's default function memory is 1024 MB; FashionCLIP ONNX is ~150 MB
  // resident. If RSS is creeping toward the limit the route is one OOM away
  // from silently dying on next cold boot.
  if (typeof process !== "undefined" && typeof process.memoryUsage === "function") {
    const m = process.memoryUsage();
    checks.memory_mb = {
      rss:        Math.round(m.rss        / 1024 / 1024),
      heap_used:  Math.round(m.heapUsed   / 1024 / 1024),
      heap_total: Math.round(m.heapTotal  / 1024 / 1024),
      external:   Math.round(m.external   / 1024 / 1024),
    };
  }

  // ── 6. Environment hints ──────────────────────────────────────────────────
  checks.env = {
    region:        process.env.VERCEL_REGION ?? "local",
    runtime:       process.env.NEXT_RUNTIME  ?? "nodejs",
    pinecone:      !!process.env.PINECONE_API_KEY,
    pinecone_index: process.env.PINECONE_INDEX ?? null,
    // Commit SHA stamp so the caller can verify which deployment they hit.
    // VERCEL_GIT_COMMIT_SHA is set on every Vercel build; first 7 chars
    // line up with the short hash git log shows.
    commit:        (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  };

  return NextResponse.json({
    summary: {
      healthy:      failures.length === 0,
      total_ms:     Date.now() - wallStart,
      failures,
    },
    checks,
  });
}
