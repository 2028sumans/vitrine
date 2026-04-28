/**
 * Tier 1 helper: imports lib/ai.ts directly and runs textQueryToAesthetic
 * for each brief. Prints the relevant fields. Run via:
 *   npx tsx scripts/eval-visual-signature-tier1.mts
 */
import { existsSync, readFileSync } from "fs";
import path from "path";

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

const BRIEFS = [
  { brief: "y2k party",                    type: "abstract" },
  { brief: "old money cream cable knit",   type: "mixed"    },
  { brief: "dad core wide leg trouser",    type: "mixed"    },
  { brief: "blue khaite dress for summer", type: "literal"  },
  { brief: "cottagecore picnic",           type: "abstract" },
  { brief: "streetwear hoodie black",      type: "literal"  },
];

async function main() {
  const { textQueryToAesthetic } = await import("../lib/ai");
  console.log("\n" + "=".repeat(78));
  console.log("Tier 1 — StyleDNA prompt sanity check");
  console.log("=".repeat(78) + "\n");

  for (const { brief, type } of BRIEFS) {
    console.log(`── [${type.padEnd(8)}] "${brief}"`);
    try {
      const dna = await textQueryToAesthetic(brief);
      const desc = (dna.aesthetic_descriptor ?? "").trim();
      const alts = (dna.aesthetic_descriptor_alts ?? []).filter(Boolean);
      const sig  = (dna.visual_signature ?? "").trim();

      console.log(`   descriptor:      ${desc || "(missing!)"}`);
      console.log(`   descriptor_alts: ${alts.join(" | ") || "(missing)"}`);
      console.log(`   signature:       ${sig || "(MISSING — Claude didn't emit field)"}`);

      const lower = sig.toLowerCase();
      const checks = {
        hasPhoto:           lower.startsWith("a photo of"),
        mentionsSilhouette: /\b(midi|maxi|mini|relaxed|tight|oversized|fitted|tailored|wide-leg|wide|slim|cropped|long|short|drop[- ]?shoulder|a-line|pleated|column|halter|strappy|low[- ]?rise|baggy|skinny|loose|drapey|drape)\b/.test(lower),
        mentionsFabric:     /\b(linen|silk|wool|cotton|cashmere|satin|leather|denim|knit|cable[- ]?knit|tweed|metallic|rhinestone|sequin|chiffon|mesh|fleece|jersey|poplin|chambray|polyester|nylon|suede|velvet|crepe|gauze|eyelet|smock|smocked|terry|fluffy|fluffy|fleece|corduroy|tulle|satin|gabardine|brocade)\b/.test(lower),
        notTooShort:        sig.length > 25,
        notTooLong:         sig.length < 350,
      };
      const pass = Object.values(checks).filter(Boolean).length;
      console.log(`   tier1 score: ${pass}/5  ${Object.entries(checks).map(([k, v]) => `${v ? "✓" : "✗"}${k}`).join(" ")}`);
    } catch (e) {
      console.log(`   ERROR: ${(e as Error).message?.slice(0, 200) ?? e}`);
    }
    console.log();
  }
}

main();
