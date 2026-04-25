import { algoliasearch } from "algoliasearch";
import fs from "fs";
import path from "path";

const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const APP_ID    = process.env.ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PC_KEY    = process.env.PINECONE_API_KEY;
const PC_INDEX  = process.env.PINECONE_INDEX ?? "muse";

if (!ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

const client = algoliasearch(APP_ID, ADMIN_KEY);

const toDelete = new Set();
const reasons  = new Map();

// Full browse: $0 price hits + the two specific titles
const TARGET_TITLES = [
  { brand: "Nordic Poetry", titleSub: "Vintage S/S 2003 Striped Shirt" },
  { brand: "Oak + Fort",    titleSub: "Spirit Wares Smooth Slate Ramekin" },
];

let scanned = 0;
await client.browseObjects({
  indexName: "vitrine_products",
  browseParams: {
    query: "",
    hitsPerPage: 1000,
    attributesToRetrieve: ["objectID", "title", "brand", "price"],
  },
  aggregator: (res) => {
    for (const hit of res.hits) {
      scanned++;
      // $0 products
      if (hit.price === 0) {
        toDelete.add(hit.objectID);
        reasons.set(hit.objectID, "price=$0");
      }
      // Specific titles
      const titleLc = String(hit.title ?? "").toLowerCase();
      const brandLc = String(hit.brand ?? "").toLowerCase();
      for (const t of TARGET_TITLES) {
        if (brandLc.includes(t.brand.toLowerCase().replace(/\s+/g, " ")) &&
            titleLc.includes(t.titleSub.toLowerCase())) {
          toDelete.add(hit.objectID);
          reasons.set(hit.objectID, `title: ${t.brand} / ${t.titleSub}`);
        }
      }
    }
    process.stdout.write(`\r  scanned ${scanned.toLocaleString()} | flagged ${toDelete.size.toLocaleString()}`);
  },
});

console.log(`\n\nFlagged: ${toDelete.size}`);
const breakdown = {};
for (const r of reasons.values()) breakdown[r] = (breakdown[r] ?? 0) + 1;
console.log("  Breakdown:");
for (const [k, v] of Object.entries(breakdown)) {
  console.log(`    ${v.toString().padStart(5)}  ${k}`);
}

if (toDelete.size === 0) { console.log("Nothing to delete."); process.exit(0); }

const ids = [...toDelete];
const BATCH = 1000;

// Algolia
console.log("\nDeleting from Algolia…");
for (let i = 0; i < ids.length; i += BATCH) {
  const batch = ids.slice(i, i + BATCH);
  await client.deleteObjects({ indexName: "vitrine_products", objectIDs: batch });
  process.stdout.write(`\r  deleted ${Math.min(i + BATCH, ids.length).toLocaleString()}/${ids.length.toLocaleString()}`);
}
console.log(`\n✓ Algolia: deleted ${ids.length}`);

// Pinecone
if (PC_KEY) {
  console.log("\nDeleting from Pinecone…");
  const { Pinecone } = await import("@pinecone-database/pinecone");
  const pc = new Pinecone({ apiKey: PC_KEY });
  const ns = pc.index(PC_INDEX).namespace("__default__");
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try { await ns.deleteMany({ ids: batch }); done += batch.length;
      process.stdout.write(`\r  deleted ${done.toLocaleString()}/${ids.length.toLocaleString()}`);
    } catch (e) { console.warn(`\n  batch ${i} failed: ${e.message}`); }
  }
  console.log(`\n✓ Pinecone: processed ${done.toLocaleString()}`);
}

console.log("\nDone.");
