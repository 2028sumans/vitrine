"use client";

/**
 * /edit — "Your Edit"
 *
 * Lightweight grid of every product the user has tapped Save on across
 * /shop / /brands / brand-scoped scroll views. Reads from localStorage
 * (see lib/saved.ts). No Algolia round-trip — we stash the full product
 * shape on save so this page renders instantly offline.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { readSaved, removeSaved, type SavedProduct } from "@/lib/saved";
import { MobileMenu } from "../_components/MobileMenu";

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

export default function EditPage() {
  const [items, setItems] = useState<SavedProduct[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setItems(readSaved());
    setLoaded(true);
  }, []);

  const onRemove = (objectID: string) => {
    setItems(removeSaved(objectID));
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — matches /shop and /brands */}
      <header className="fixed top-0 left-0 right-0 z-50 px-8 py-2.5 bg-background/85 backdrop-blur-sm flex items-center justify-between">
        <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground hover:opacity-80 transition-opacity">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Tailor to my taste →</Link>
          <Link href="/shop"     className="text-muted hover:text-foreground transition-colors">Shop</Link>
          <Link href="/brands"   className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/edit"     className="text-foreground hover:text-accent transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/dashboard", label: "Tailor to my taste →" },
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1 pt-24 pb-24 px-8 max-w-7xl mx-auto w-full">
        <div className="mb-10">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Saved pieces</p>
          <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
            Your shortlist
          </h1>
          <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
            {loaded && items.length === 0
              ? "Nothing saved yet. Tap Save on anything you like in Shop or a brand feed, and it lands here."
              : `${items.length} piece${items.length === 1 ? "" : "s"} you've saved, newest first.`}
          </p>
        </div>

        {loaded && items.length === 0 ? (
          <div className="border-t border-border-mid py-16 flex flex-col items-center justify-center text-center">
            <p className="font-display italic text-2xl text-muted-strong mb-4">
              An empty room, waiting.
            </p>
            <Link
              href="/shop"
              className="inline-block px-6 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors"
            >
              Browse the shop →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 border-t border-border-mid pt-10">
            {items.map((p) => <SavedTile key={p.objectID} product={p} onRemove={onRemove} />)}
          </div>
        )}
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

function SavedTile({
  product,
  onRemove,
}: {
  product:  SavedProduct;
  onRemove: (objectID: string) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const brandLabel = product.brand || product.retailer || "";
  return (
    <div className="group relative block">
      <a
        href={product.product_url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        {/* Image — border + shadow live here, not on the whole tile. */}
        <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card group-hover:shadow-card-hover group-hover:border-border-mid transition-all duration-300">
          {product.image_url && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt={product.title}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
              onError={() => setImgFailed(true)}
            />
          ) : null}
        </div>
        {/* Text row — outside the border. Brand > title > price. */}
        <div className="pt-3">
          {brandLabel && (
            <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{brandLabel}</p>
          )}
          <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">{product.title}</p>
          <div className="flex items-center justify-between">
            {product.price != null ? (
              <span className="font-sans text-xs font-medium text-foreground">{formatPrice(product.price)}</span>
            ) : <span />}
            <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-accent transition-colors">Shop →</span>
          </div>
        </div>
      </a>

      {/* Remove button — sits on the image, top-right. Visible on hover
          on desktop; on touch :hover is flaky so we also reveal on
          focus-within. */}
      <button
        aria-label="Remove from saved"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(product.objectID);
        }}
        className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-background/90 border border-border-mid flex items-center justify-center text-foreground/70 hover:text-foreground hover:border-foreground/60 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-200"
      >
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="5" x2="19" y2="19" />
          <line x1="19" y1="5" x2="5" y2="19" />
        </svg>
      </button>
    </div>
  );
}
