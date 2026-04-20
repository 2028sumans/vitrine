/**
 * Taste-aware projection head: applies the trained W ∈ R^(D×D) to a
 * FashionCLIP vector so downstream cosine similarity is computed in the
 * Vitrine-taste-aware space instead of the raw FashionCLIP space.
 *
 * Training happens offline via scripts/train-taste-head.mjs on the
 * keep/reject signal collected by lib/curation-log.ts. Weights live at
 * lib/taste-head.json and are loaded lazily here — the file is ~2 MB at
 * D=512 so we only load it when a request actually needs a taste-projected
 * vector.
 *
 * When the weights file is missing (pre-training), all helpers degrade to
 * identity (return the input unchanged) so feature-flagging is trivial.
 */
import { promises as fs } from "fs";
import path from "path";

interface TasteHead {
  version:   number;
  dim:       number;
  W:         number[]; // row-major D*D matrix
}

let _cache: Promise<TasteHead | null> | null = null;

async function load(): Promise<TasteHead | null> {
  if (_cache) return _cache;
  _cache = (async () => {
    const p = path.resolve(process.cwd(), "lib/taste-head.json");
    try {
      const buf = await fs.readFile(p, "utf8");
      const raw = JSON.parse(buf) as TasteHead;
      if (!raw?.W?.length || !raw?.dim || raw.W.length !== raw.dim * raw.dim) return null;
      return raw;
    } catch {
      return null;
    }
  })();
  return _cache;
}

/** Zero dependency on the load path — call this from tests to inject weights. */
export function __setTasteHeadForTests(head: TasteHead | null): void {
  _cache = Promise.resolve(head);
}

/** Is there a trained taste head available? Cheap to call repeatedly. */
export async function tasteHeadAvailable(): Promise<boolean> {
  return (await load()) != null;
}

function normalize(v: number[]): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** y = W · x, with y re-normalized. Identity when no head is loaded. */
export async function applyTasteHead(x: number[]): Promise<number[]> {
  const head = await load();
  if (!head || x.length !== head.dim) return x;
  const D = head.dim;
  const W = head.W;
  const out = new Array<number>(D);
  for (let i = 0; i < D; i++) {
    let s = 0;
    const base = i * D;
    for (let j = 0; j < D; j++) s += W[base + j] * x[j];
    out[i] = s;
  }
  return normalize(out);
}

/** Batch variant — avoids awaiting the head load D times in a tight loop. */
export async function applyTasteHeadBatch(xs: number[][]): Promise<number[][]> {
  const head = await load();
  if (!head) return xs;
  const D = head.dim;
  const W = head.W;
  const out: number[][] = [];
  for (const x of xs) {
    if (x.length !== D) { out.push(x); continue; }
    const y = new Array<number>(D);
    for (let i = 0; i < D; i++) {
      let s = 0;
      const base = i * D;
      for (let j = 0; j < D; j++) s += W[base + j] * x[j];
      y[i] = s;
    }
    out.push(normalize(y));
  }
  return out;
}
