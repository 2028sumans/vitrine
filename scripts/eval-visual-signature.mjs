#!/usr/bin/env node
/**
 * Eval harness for the visual_signature StyleDNA field.
 *
 * Tier 1 (--tier1): Print the StyleDNA Claude returns for each brief —
 *                   confirms the prompt is producing concrete signatures.
 * Tier 2 (--tier2): Run /api/shop with USE_VISUAL_SIGNATURE on then off,
 *                   diff top-N results per category, surface cosine shifts.
 *
 * Usage:
 *   node scripts/eval-visual-signature.mjs --tier1
 *   node scripts/eval-visual-signature.mjs --tier2 --base-url https://vitrine-livid-pi.vercel.app
 *   node scripts/eval-visual-signature.mjs --tier1 --tier2
 *
 * Env: ANTHROPIC_API_KEY required for tier 1. Reads .env.local automatically.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

// ── Load .env.local ─────────────────────────────────────────────────────────
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      const [, k, raw] = m;
      const v = raw.replace(/^["']|["']$/g, "");
      if (k === "PINECONE_INDEX" && /[=\s]/.test(v)) continue;
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const RUN_TIER1   = args.includes("--tier1");
const RUN_TIER2   = args.includes("--tier2");
const BASE_URL    = (() => {
  const i = args.indexOf("--base-url");
  return i >= 0 && args[i + 1] ? args[i + 1] : "https://vitrine-livid-pi.vercel.app";
})();
if (!RUN_TIER1 && !RUN_TIER2) {
  console.error("Usage: node scripts/eval-visual-signature.mjs --tier1 [--tier2] [--base-url URL]");
  process.exit(1);
}

// ── Eval briefs ─────────────────────────────────────────────────────────────
// Mix of abstract / mixed / literal queries. Anti-leak patterns are what
// each brief should NOT surface — used by Tier 2 to count regressions.
const BRIEFS = [
  { brief: "y2k party",                    type: "abstract", antiLeak: ["floral", "modest", "athletic", "office", "minimalist"] },
  { brief: "old money cream cable knit",   type: "mixed",    antiLeak: ["logo", "neon", "graphic", "synthetic", "athletic"] },
  { brief: "dad core wide leg trouser",    type: "mixed",    antiLeak: ["bodycon", "mini", "feminine", "lace", "satin"] },
  { brief: "blue khaite dress for summer", type: "literal",  antiLeak: ["maxi", "puff sleeve", "winter", "wool"] },
  { brief: "cottagecore picnic",           type: "abstract", antiLeak: ["bodycon", "metallic", "leather", "athletic"] },
  { brief: "streetwear hoodie black",      type: "literal",  antiLeak: ["sequin", "lace", "satin", "feminine", "pastel"] },
];

// ── Tier 1 ──────────────────────────────────────────────────────────────────
async function tier1() {
  console.log("\n" + "=".repeat(78));
  console.log("Tier 1 — StyleDNA prompt sanity check (visual_signature presence + shape)");
  console.log("=".repeat(78) + "\n");

  // Dynamic import so failure to load the project's TS-compiled lib doesn't
  // crash us before we report. We import via the running Next dev/prod build's
  // bundled output through a network call instead — POST to /api/shop with
  // the simplest possible context and read the StyleDNA from the candidates
  // emit. But that's heavy. Cleaner: hit a debug endpoint OR run textQuery-
  // ToAesthetic locally via tsx.
  //
  // Practical path: spawn a tsx subprocess that imports lib/ai.ts directly
  // and prints the StyleDNA JSON for each brief. Avoids needing a server.
  const { spawn } = await import("child_process");
  for (const { brief, type, antiLeak } of BRIEFS) {
    console.log(`── [${type.padEnd(8)}] "${brief}"`);
    const out = await new Promise((resolve) => {
      const child = spawn("npx", ["tsx", "-e", `
        import { textQueryToAesthetic } from "@/lib/ai";
        const brief = ${JSON.stringify(brief)};
        const dna = await textQueryToAesthetic(brief);
        const summary = {
          aesthetic_descriptor:      dna.aesthetic_descriptor,
          aesthetic_descriptor_alts: dna.aesthetic_descriptor_alts,
          visual_signature:          dna.visual_signature,
        };
        process.stdout.write(JSON.stringify(summary, null, 2));
      `], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", () => resolve({ stdout, stderr }));
    });
    try {
      const j = JSON.parse(out.stdout);
      console.log(`   descriptor:      ${j.aesthetic_descriptor || "(missing!)"}`);
      console.log(`   descriptor_alts: ${(j.aesthetic_descriptor_alts ?? []).join(" | ") || "(missing)"}`);
      console.log(`   signature:       ${j.visual_signature || "(MISSING — prompt not emitting field!)"}`);

      // Pass/fail heuristics
      const sig = (j.visual_signature ?? "").toLowerCase();
      const checks = {
        hasPhoto:    sig.startsWith("a photo of"),
        mentionsSilhouette: /\b(midi|maxi|mini|relaxed|tight|oversized|fitted|tailored|wide|slim|cropped|long|short|drop)\b/.test(sig),
        mentionsFabric:     /\b(linen|silk|wool|cotton|cashmere|satin|leather|denim|knit|cable|tweed|metallic|rhinestone|sequin|chiffon|mesh|fleece|jersey|poplin|chambray|polyester|nylon|suede|velvet|crepe|gauze)\b/.test(sig),
        notEmpty:           sig.length > 20,
      };
      const passes = Object.values(checks).filter(Boolean).length;
      console.log(`   tier1 score: ${passes}/4  ${Object.entries(checks).map(([k, v]) => `${v ? "✓" : "✗"}${k}`).join(" ")}`);
    } catch (e) {
      console.log(`   ERROR: ${out.stderr.slice(0, 300)}`);
    }
    console.log();
  }
}

// ── Tier 2 ──────────────────────────────────────────────────────────────────
async function callShop(brief, baseUrl, signatureOn) {
  // Pure curl-style HTTP. We don't have a flag in the request body — the
  // server reads USE_VISUAL_SIGNATURE from env. Tier 2 therefore needs TWO
  // deploys (or a runtime flag in the request).
  //
  // Practical workaround: pass the toggle via a custom header that the
  // route can read for eval purposes. For now, document that this tier
  // requires deploying with the env var flipped between runs OR a code
  // tweak to read a request header. We default to "as deployed" and just
  // print the response shape so you can compare across two runs by hand.
  const url = `${baseUrl}/api/shop`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Visual-Signature": signatureOn ? "1" : "0" },
    body: JSON.stringify({
      contexts: [{ mode: "text", textQuery: brief }],
    }),
  });
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, products: [] };
  }
  // /api/shop streams events. Parse out the candidates phase.
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim().startsWith("{"));
  let candidates = null;
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      if (ev.phase === "candidates") candidates = ev.candidates;
    } catch { /* skip */ }
  }
  return { products: candidates ?? {} };
}

async function tier2() {
  console.log("\n" + "=".repeat(78));
  console.log(`Tier 2 — Retrieval comparison via ${BASE_URL}`);
  console.log("=".repeat(78));
  console.log("Note: this tier compares signature-ON vs signature-OFF responses.");
  console.log("To compare, run twice with USE_VISUAL_SIGNATURE flipped, save");
  console.log("each run's output, then diff. This script just dumps the current");
  console.log("server's response (whatever flag it has).\n");

  const ts      = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir  = `scripts/eval-output-${ts}`;
  mkdirSync(outDir, { recursive: true });

  for (const { brief, type, antiLeak } of BRIEFS) {
    process.stdout.write(`── [${type.padEnd(8)}] "${brief}" ... `);
    const r = await callShop(brief, BASE_URL, true);
    const file = path.join(outDir, `${brief.replace(/[^a-z0-9]+/gi, "-")}.json`);
    writeFileSync(file, JSON.stringify(r, null, 2));
    if (r.error) {
      console.log(`ERROR: ${r.error}`);
      continue;
    }
    // Per-category top 3 + anti-leak count
    const cats = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
    const products = r.products || {};
    let antiLeakCount = 0;
    for (const c of cats) {
      const items = products[c] ?? [];
      if (items.length === 0) continue;
      const top3 = items.slice(0, 3).map((p) => `${p.brand ?? "?"}: ${(p.title ?? "?").slice(0, 40)}`);
      const cnt  = items.slice(0, 6).filter((p) => {
        const t = (p.title ?? "").toLowerCase();
        return antiLeak.some((leak) => t.includes(leak));
      }).length;
      antiLeakCount += cnt;
    }
    const totalSurfaced = cats.reduce((sum, c) => sum + (products[c]?.length ?? 0), 0);
    console.log(`${totalSurfaced} items, anti-leak hits: ${antiLeakCount}`);
  }
  console.log(`\n✓ Wrote per-brief responses to ${outDir}/`);
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  if (RUN_TIER1) await tier1();
  if (RUN_TIER2) await tier2();
})().catch((e) => { console.error(e); process.exit(1); });
