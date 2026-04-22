"use client";

/**
 * One product tile on an /edits/[slug] page. Mirrors the /edit (shortlist)
 * tile, but with an add/remove save toggle instead of a remove-only button.
 * Kept local to /edits so the save UX for curated edits can evolve without
 * perturbing the existing shortlist page.
 */
import { useEffect, useState } from "react";
import { addSaved, removeSaved, isSaved, type SavedProduct } from "@/lib/saved";

type TileProduct = Omit<SavedProduct, "savedAt"> & {
  retailer?: string;
};

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

export default function EditSaveTile({ product }: { product: TileProduct }) {
  const [saved, setSaved] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const brandLabel = product.brand || product.retailer || "";

  // Hydrate save state once on mount (localStorage only available client-side)
  useEffect(() => {
    setSaved(isSaved(product.objectID));
  }, [product.objectID]);

  const toggleSave = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (saved) {
      removeSaved(product.objectID);
      setSaved(false);
    } else {
      addSaved(product);
      setSaved(true);
    }
  };

  return (
    <div className="group relative block">
      <a
        href={product.product_url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
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

      {/* Heart toggle — sits on the image, top-right. Filled when saved. */}
      <button
        aria-label={saved ? "Remove from saved" : "Save to shortlist"}
        aria-pressed={saved}
        onClick={toggleSave}
        className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-background/90 border border-border-mid flex items-center justify-center text-foreground/70 hover:text-foreground hover:border-foreground/60 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-200"
        style={saved ? { opacity: 1, color: "#2A3316" } : undefined}
      >
        <svg
          viewBox="0 0 24 24"
          className="w-3.5 h-3.5"
          fill={saved ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>
    </div>
  );
}
