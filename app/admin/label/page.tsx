"use client";

/**
 * /admin/label — index page for the per-category golden-set labeling tools.
 *
 * Lists all 7 categories from the canonical taxonomy with per-category
 * progress (read live from each category's localStorage entry). Click
 * through to /admin/label/<slug> to label that category.
 *
 * The per-category tool itself lives at app/admin/label/[category]/page.tsx
 * — this file is just navigation + at-a-glance progress.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CATEGORIES } from "@/lib/category-taxonomy";

const AGE_KEYS = ["age-13-18", "age-18-25", "age-25-32", "age-32-40", "age-40-60"] as const;
const TARGET_PER_AESTHETIC = 40;

interface CategoryProgress {
  /** Total tags across all age buckets in this category. */
  total: number;
  /** Per-bucket counts in canonical age order. */
  perBucket: number[];
  /** Number of unique items (less than total when an item has multiple tags). */
  uniqueItems: number;
}

function readProgress(slug: string): CategoryProgress {
  if (typeof window === "undefined") {
    return { total: 0, perBucket: AGE_KEYS.map(() => 0), uniqueItems: 0 };
  }
  try {
    const raw = localStorage.getItem(`muse-eval-labels-${slug}-v1`);
    if (!raw) return { total: 0, perBucket: AGE_KEYS.map(() => 0), uniqueItems: 0 };
    const parsed = JSON.parse(raw);
    const labels = (parsed?.labels ?? {}) as Record<string, unknown>;

    let total = 0;
    let unique = 0;
    const perBucket = new Array(AGE_KEYS.length).fill(0);
    for (const v of Object.values(labels)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      unique++;
      for (const k of v) {
        if (typeof k !== "string") continue;
        const idx = AGE_KEYS.indexOf(k as typeof AGE_KEYS[number]);
        if (idx >= 0) { perBucket[idx]++; total++; }
      }
    }
    return { total, perBucket, uniqueItems: unique };
  } catch {
    return { total: 0, perBucket: AGE_KEYS.map(() => 0), uniqueItems: 0 };
  }
}

export default function AdminLabelIndex() {
  // Read localStorage once on mount. Re-runs on focus so a labeling session
  // in another tab is reflected when the user comes back to the index.
  const [progress, setProgress] = useState<Record<string, CategoryProgress>>({});

  useEffect(() => {
    const refresh = () => {
      const next: Record<string, CategoryProgress> = {};
      for (const c of CATEGORIES) next[c.slug] = readProgress(c.slug);
      setProgress(next);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const targetPerCategory = AGE_KEYS.length * TARGET_PER_AESTHETIC;
  const grandTotal        = Object.values(progress).reduce((n, p) => n + p.total, 0);
  const grandTarget       = CATEGORIES.length * targetPerCategory;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border-mid">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground">
              MUSE
            </Link>
            <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
              Admin · golden datasets
            </span>
          </div>
          <span className="font-sans text-[10px] tracking-widest uppercase text-muted-strong tabular-nums">
            {grandTotal}/{grandTarget}
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="font-display font-light text-4xl text-foreground leading-tight mb-3">
            One category at a time.
          </h1>
          <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
            Each row is a separate golden dataset. Open one, label ~40 items per age bucket,
            download the JSON, run the build scripts. Switching between categories never
            cross-contaminates — every category has its own localStorage and its own
            generated centroids.
          </p>
        </div>

        <ul className="divide-y divide-border-mid">
          {CATEGORIES.map((c) => {
            const p = progress[c.slug] ?? { total: 0, perBucket: AGE_KEYS.map(() => 0), uniqueItems: 0 };
            const pct = Math.min(100, (p.total / targetPerCategory) * 100);
            const allDone = AGE_KEYS.every((_, i) => (p.perBucket[i] ?? 0) >= TARGET_PER_AESTHETIC);
            return (
              <li key={c.slug}>
                <Link
                  href={`/admin/label/${c.slug}`}
                  className="block py-6 hover:bg-[rgba(42,51,22,0.04)] transition-colors -mx-3 px-3 rounded-sm"
                >
                  <div className="flex items-baseline justify-between mb-2">
                    <h2 className="font-display font-light text-2xl text-foreground">
                      {c.label}
                    </h2>
                    <span className={`font-sans text-[10px] tracking-widest uppercase tabular-nums ${
                      allDone ? "text-accent" : "text-muted"
                    }`}>
                      {p.total}/{targetPerCategory}
                      {p.uniqueItems > 0 && (
                        <span className="ml-3 text-muted-dim">{p.uniqueItems} unique</span>
                      )}
                    </span>
                  </div>

                  {/* Single-line per-bucket dots — visual at-a-glance signal
                      of which age buckets are full and which are bare. */}
                  <div className="flex gap-1 items-center">
                    {AGE_KEYS.map((key, i) => {
                      const n = p.perBucket[i] ?? 0;
                      const bucketDone = n >= TARGET_PER_AESTHETIC;
                      const bucketEmpty = n === 0;
                      return (
                        <div key={key} className="flex-1">
                          <div className="h-0.5 bg-border w-full">
                            <div
                              className={`h-full transition-all ${
                                bucketDone ? "bg-accent" : bucketEmpty ? "bg-transparent" : "bg-foreground"
                              }`}
                              style={{ width: `${Math.min(100, (n / TARGET_PER_AESTHETIC) * 100)}%` }}
                            />
                          </div>
                          <p className="font-sans text-[9px] tracking-widest uppercase text-muted-dim mt-1 text-center tabular-nums">
                            {key.replace("age-", "")}
                          </p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Overall pct bar at the bottom — quick summary number */}
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1 h-px bg-border">
                      <div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="font-sans text-[10px] tracking-widest uppercase text-muted-dim tabular-nums whitespace-nowrap">
                      Open →
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
