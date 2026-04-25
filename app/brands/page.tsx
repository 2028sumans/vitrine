"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import brandsData from "./brands.json";
import { MobileMenu } from "../_components/MobileMenu";

interface Brand {
  name:     string;
  count:    number;
  imageUrl: string | null;
}

// Data is baked in at build time via scripts/build-brands-data.mjs.
// Alphabetical is the fallback / anonymous-user view. Signed-in users get
// their grid reordered by cosine-similarity of each brand's centroid to
// their taste vector (see useEffect below).
const ALPHABETICAL_BRANDS: Brand[] = [...(brandsData.brands as Brand[])].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/**
 * Rewrite a Shopify CDN URL to request a ~500px-wide thumbnail instead of
 * the full-size original. Without this, 249 full-res product shots were
 * tipping older iPads into an OOM loop ("a problem repeatedly occurred")
 * because Safari decoded every image to raw pixels as the user scrolled.
 * Shopify's CDN honours `?width=N` and preserves aspect ratio.
 */
function thumbUrl(url: string | null, px: number = 500): string | null {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(px));
    return u.toString();
  } catch {
    return url;
  }
}

export default function BrandsPage() {
  const { data: session } = useSession();
  const userToken = session?.user?.id ?? "";

  // Taste-ordered brand names from /api/brands/ordered, or null while we
  // wait for the fetch to resolve. Null also means "use alphabetical" —
  // anon users and taste-unavailable sessions land here without a round-trip.
  const [orderedNames, setOrderedNames] = useState<string[] | null>(null);

  useEffect(() => {
    if (!userToken) { setOrderedNames(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/brands/ordered?userToken=${encodeURIComponent(userToken)}`);
        if (!res.ok) return;
        const j = await res.json();
        if (cancelled) return;
        if (j?.ordered && Array.isArray(j.brands)) {
          setOrderedNames(j.brands as string[]);
        }
      } catch {
        // Network flake — leave alphabetical in place. No user-visible error
        // is worthwhile here; the page still works, just not sorted for them.
      }
    })();
    return () => { cancelled = true; };
  }, [userToken]);

  // Reorder the brand grid. When ordering is unavailable (anon, fetch
  // pending, or endpoint returned ordered=false) we keep alphabetical.
  // When ordered, we index brands.json by name and emit them in the
  // taste-ranked order. Brands the endpoint returned that aren't in our
  // static data are skipped; brands in our data missing from the endpoint's
  // list (shouldn't happen if the centroid builder is in sync) land at
  // the end alphabetically so nothing disappears.
  const brands = useMemo<Brand[]>(() => {
    if (!orderedNames) return ALPHABETICAL_BRANDS;
    const byName = new Map(ALPHABETICAL_BRANDS.map((b) => [b.name, b]));
    const ordered: Brand[] = [];
    const seen = new Set<string>();
    for (const name of orderedNames) {
      const b = byName.get(name);
      if (b) { ordered.push(b); seen.add(name); }
    }
    const tail = ALPHABETICAL_BRANDS.filter((b) => !seen.has(b.name));
    return [...ordered, ...tail];
  }, [orderedNames]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <Link href="/" className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/shop"   className="text-muted hover:text-foreground transition-colors">Shop</Link>
          <Link href="/brands" className="text-foreground hover:text-accent transition-colors">Brands</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1 pt-24 pb-24 px-8 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="mb-12">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">The catalog</p>
          <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
            Brands
          </h1>
          <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
            An evolving archive of sustainable labels, vintage stores, preloved platforms,
            and ethical small-batch makers. Every piece in your feed comes from one of these.
          </p>
        </div>

        {/* Grid — taste-ranked for signed-in users (cosine-similarity of
            each brand's centroid to the user's taste vector), alphabetical
            for anonymous visitors. Re-order happens client-side after
            /api/brands/ordered resolves; the first paint shows alphabetical
            and seamlessly re-orders in place. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
          {brands.map((b) => <BrandCard key={b.name} brand={b} />)}
        </div>
      </main>

      <footer className="border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.18em] text-sm text-muted hover:text-foreground transition-colors">MUSE</Link>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <span>© 2025</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function BrandCard({ brand }: { brand: Brand }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = thumbUrl(brand.imageUrl);
  return (
    <Link
      href={`/shop?brand=${encodeURIComponent(brand.name)}`}
      className="group relative aspect-[3/4] overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card hover:shadow-card-hover transition-all duration-300 block"
    >
      {src && !imgFailed ? (
        // Plain <img> (not Next/Image) so we can pass decoding="async" and
        // keep the browser's native lazy-loading heuristics. On iOS Safari
        // this prevents the full decoded bitmap for every off-screen card
        // from living in memory simultaneously.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={brand.name}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
          onError={() => setImgFailed(true)}
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 p-4">
        <h3 className="font-display font-light text-xl text-white leading-tight drop-shadow-sm">{brand.name}</h3>
      </div>
    </Link>
  );
}
