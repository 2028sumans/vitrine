/**
 * /edits/[slug] — single edit detail page.
 *
 * Server component: reads the edit by slug from content/edits.json and hydrates
 * the product_ids via Algolia. Grid below mirrors /edit and /brands card style.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEditBySlug, listEdits } from "@/lib/edits";
import { getProductsByIds } from "@/lib/algolia";
import { MobileMenu } from "../../_components/MobileMenu";
import EditInfiniteGrid from "./EditInfiniteGrid";

// Pre-render all edits at build time.
export async function generateStaticParams() {
  return listEdits().map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const edit = getEditBySlug(slug);
  if (!edit) return { title: "Edit — MUSE" };
  return {
    title:       `${edit.title} — MUSE`,
    description: edit.subtitle,
  };
}

export default async function EditDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const edit = getEditBySlug(slug);
  if (!edit) notFound();

  const products = edit.product_ids.length ? await getProductsByIds(edit.product_ids) : [];
  const hero = thumbUrl(edit.hero_image_url, 1600);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <Link href="/" className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/shop?all=1" className="text-muted hover:text-foreground transition-colors">Get started →</Link>
          <Link href="/shop"   className="text-muted hover:text-foreground transition-colors">Shop</Link>
          <Link href="/brands" className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/twin"   className="text-muted hover:text-foreground transition-colors">TwinFinder</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/shop?all=1", label: "Get started →" },
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/twin",      label: "TwinFinder" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1 pt-24 pb-24">
        {/* Hero — full-width image with overlaid title, like a magazine spread. */}
        <section className="relative w-full aspect-[16/9] sm:aspect-[21/9] overflow-hidden bg-[rgba(42,51,22,0.08)]">
          {hero ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={hero}
              alt={edit.title}
              className="absolute inset-0 w-full h-full object-cover object-center"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-black/30" />
          <div className="relative h-full flex items-end px-8 pb-12 sm:pb-16 max-w-7xl mx-auto w-full">
            <div>
              <p className="font-sans text-[9px] tracking-widest uppercase text-white/80 mb-4">
                <Link href="/edits" className="hover:text-white transition-colors">← All edits</Link>
              </p>
              <h1 className="font-display font-light text-5xl sm:text-6xl md:text-7xl text-white leading-tight mb-3 drop-shadow-sm">
                {edit.title}
              </h1>
              <p className="font-display font-light italic text-xl sm:text-2xl text-white/85 max-w-[30ch]">
                {edit.subtitle}
              </p>
            </div>
          </div>
        </section>

        {/* Editorial copy */}
        <section className="px-8 pt-14 pb-10 max-w-3xl mx-auto">
          <p className="font-sans text-[10px] tracking-widest uppercase text-muted">
            {products.length} piece{products.length === 1 ? "" : "s"}
          </p>
        </section>

        {/* Product grid — curated seed + infinite-scroll tail pulled from the
            full 100K catalog. The steer (edit title + subtitle) rank-boosts
            on-brief products in optional-words space; the optional `filter`
            block on the edit JSON hard-scopes the tail when it needs to stay
            tight (e.g. a Swimwear edit pins categoryFilter to "Tops" so the
            pagination can't drift into denim or cashmere). */}
        <section className="px-8 pb-24 max-w-7xl mx-auto">
          <EditInfiniteGrid
            editTitle={edit.title}
            editSubtitle={edit.subtitle}
            filter={edit.filter}
            initial={products.map((p) => ({
              objectID:    p.objectID,
              title:       p.title,
              brand:       p.brand,
              retailer:    p.retailer,
              price:       p.price,
              image_url:   p.image_url,
              product_url: p.product_url,
              category:    p.category,
              color:       p.color,
              price_range: p.price_range,
              title_en:    p.title_en,
            }))}
          />
        </section>
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
