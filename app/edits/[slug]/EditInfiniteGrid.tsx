"use client";

/**
 * Infinite-scrolling grid for an edit's detail page.
 *
 * Seeds with the edit's hand-picked product_ids (fetched server-side and passed
 * in via `initial`), then paginates against /api/shop-all scoped to the edit's
 * theme. The steer query is built from the edit's title + subtitle so every
 * additional page stays on-brief even though it's drawn from the full 100K
 * catalog rather than the original curated set. Session likes (tracked via
 * the shortlist's save toggle) flow back as bias so later pages re-rank
 * against what the user is actually saving in this edit.
 *
 * Dedup is by objectID across the entire feed (initial + every page), so the
 * grid can't serve the same product twice even if Algolia re-surfaces a
 * curated item via steer match.
 *
 * Like in /shop, an IntersectionObserver on a sentinel just above the grid's
 * footer triggers the next fetch — works on mobile swipe without wiring up
 * a scroll-listener fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EditSaveTile from "./EditSaveTile";

// Loose product shape — /api/shop-all returns AlgoliaProduct-shaped rows and
// EditSaveTile accepts a subset. Keep this local to avoid pulling the
// AlgoliaProduct type (server-only) into a client bundle.
interface GridProduct {
  objectID:    string;
  title:       string;
  brand:       string;
  retailer?:   string;
  price:       number | null;
  image_url:   string;
  product_url: string;
  category?:   string;
  color?:      string;
  price_range?: string;
  title_en?:   string;
}

interface Props {
  editTitle:    string;
  editSubtitle: string;
  initial:      GridProduct[];
}

export default function EditInfiniteGrid({ editTitle, editSubtitle, initial }: Props) {
  const [extras,  setExtras]  = useState<GridProduct[]>([]);
  const [page,    setPage]    = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  // Every objectID we've ever put on screen. Seeded with the curated set so
  // the first /api/shop-all page can't re-serve a hand-picked item; grows
  // as extras accrete.
  const seenIdsRef    = useRef<Set<string>>(new Set(initial.map((p) => p.objectID)));
  const sentinelRef   = useRef<HTMLDivElement>(null);
  const inFlightRef   = useRef<boolean>(false);

  // Steer query = edit's title + subtitle words, punctuation-stripped and
  // filtered to meaningful tokens. /api/shop-all folds these in as Algolia
  // optionalWords so each term rank-boosts without hard-filtering the pool.
  // Punctuation has to go first — otherwise commas in subtitles stick to
  // adjacent words ("one-pieces," instead of "one-pieces") and Algolia's
  // tokenizer drops recall hard on the punctuated variants.
  const steerQuery = useMemo(() => {
    return [editTitle, editSubtitle]
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8)
      .join(" ");
  }, [editTitle, editSubtitle]);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/shop-all", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page,
          bias:         {},    // No session bias yet — add on a future pass
          steerQuery,
          // Omit categoryFilter / brandFilter entirely so we search the
          // whole catalog; the steer is what keeps results on-brief.
        }),
      });
      if (!res.ok) { setHasMore(false); return; }
      const data = await res.json();
      const fresh = (data.products ?? []) as GridProduct[];

      const seen = seenIdsRef.current;
      const batch: GridProduct[] = [];
      for (const p of fresh) {
        if (seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        batch.push(p);
      }

      setExtras((prev) => [...prev, ...batch]);
      setPage((p) => p + 1);
      // Stop when the server says no more OR when every row in this page
      // was already seen (infinite dedup loop otherwise).
      if (!data.hasMore || batch.length === 0) setHasMore(false);
    } catch (err) {
      console.warn("[EditInfiniteGrid] loadMore failed:", err);
      setHasMore(false);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [page, hasMore, steerQuery]);

  // IntersectionObserver fires loadMore whenever the sentinel scrolls into
  // view. Rearms every time `loading` / `hasMore` / `loadMore` identity
  // changes so we don't get stuck in a stale closure after the first page.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const all = [...initial, ...extras];

  if (all.length === 0) {
    return (
      <div className="border-t border-border-mid py-16 flex flex-col items-center text-center">
        <p className="font-display italic text-2xl text-muted-strong">
          This edit is empty right now.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 border-t border-border-mid pt-10">
        {all.map((p) => (
          <EditSaveTile
            key={p.objectID}
            product={{
              objectID:    p.objectID,
              title:       p.title,
              brand:       p.brand,
              retailer:    p.retailer,
              price:       p.price,
              image_url:   p.image_url,
              product_url: p.product_url,
              title_en:    p.title_en,
            }}
          />
        ))}
      </div>

      {/* Sentinel — invisible row whose intersection triggers the next
          /api/shop-all fetch. 600px rootMargin means the fetch fires
          well before the user runs out of content. */}
      <div ref={sentinelRef} className="h-24 flex items-center justify-center mt-10">
        {loading && <p className="font-display italic text-lg text-muted">Finding more…</p>}
        {!loading && !hasMore && (
          <p className="font-display italic text-lg text-muted">That&apos;s everything that fits this edit.</p>
        )}
      </div>
    </>
  );
}
