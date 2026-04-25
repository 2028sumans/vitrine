/**
 * One-shot: delete the 91 IDs from Pinecone that were Algolia-deleted by
 * audit-category-mistags.mjs but failed the in-script Pinecone step (the
 * SDK shape was wrong on the first run — fixed in the script for future
 * runs, but these 91 are already orphaned).
 *
 * Reads the IDs from /tmp/pinecone-cleanup-ids.json (extracted from
 * scripts/category-mistag-report.json by a one-liner before running).
 *
 * Run:
 *   node --env-file=.env.local scripts/cleanup-pinecone-orphans.mjs
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { Pinecone }     from "@pinecone-database/pinecone";

const ids = JSON.parse(readFileSync("/tmp/pinecone-cleanup-ids.json", "utf8"));
console.log(`Cleaning up ${ids.length} orphaned Pinecone vectors…`);

const pc       = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const idx      = pc.index(process.env.PINECONE_INDEX ?? "muse");
const visualNs = idx.namespace("__default__");
const vibeNs   = idx.namespace("vibe");

let visualDeleted = 0, vibeDeleted = 0;
for (let i = 0; i < ids.length; i += 1000) {
  const chunk = ids.slice(i, i + 1000);
  try {
    await visualNs.deleteMany({ ids: chunk });
    visualDeleted += chunk.length;
  } catch (e) {
    console.warn(`  visual@${i}: ${e.message}`);
  }
  try {
    await vibeNs.deleteMany({ ids: chunk });
    vibeDeleted += chunk.length;
  } catch (e) {
    console.warn(`  vibe@${i}: ${e.message}`);
  }
}
console.log(`Done. visual: ${visualDeleted}, vibe: ${vibeDeleted}`);
