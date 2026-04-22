import Link from "next/link";
import type { Edit } from "@/lib/edits";

/**
 * Big hero-style card for a curated edit. Used on /edits (index) and on the
 * homepage featured section. Server- and client-safe — pure display.
 */
export function EditCard({ edit }: { edit: Edit }) {
  const src = thumbUrl(edit.hero_image_url, 900);
  return (
    <Link
      href={`/edits/${edit.slug}`}
      className="group relative aspect-[3/4] overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card hover:shadow-card-hover transition-all duration-300 block"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={edit.title}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover object-center group-hover:scale-[1.04] transition-transform duration-700"
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-black/10 pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 p-6">
        <h3 className="font-display font-light text-3xl sm:text-4xl text-white leading-tight drop-shadow-sm mb-2">
          {edit.title}
        </h3>
        <p className="font-sans text-xs text-white/85 leading-snug mb-4 max-w-[24ch]">
          {edit.subtitle}
        </p>
        <span className="font-sans text-[10px] tracking-widest uppercase text-white/80 group-hover:text-white transition-colors">
          Start exploring →
        </span>
      </div>
    </Link>
  );
}

/** Rewrite a Shopify/BigCommerce CDN URL to a narrower width variant. */
function thumbUrl(url: string | null, px: number): string | null {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(px));
    return u.toString();
  } catch {
    return url;
  }
}
