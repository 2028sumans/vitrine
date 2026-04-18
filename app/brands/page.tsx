"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useMemo } from "react";

interface Brand {
  name:     string;
  count:    number;
  imageUrl: string | null;
}

type Sort = "popular" | "alpha";

export default function BrandsPage() {
  const [brands, setBrands]   = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [sort, setSort]       = useState<Sort>("popular");

  useEffect(() => {
    fetch("/api/brands")
      .then((r) => r.json())
      .then((d) => setBrands(d.brands ?? []))
      .catch(() => { /* leave empty */ })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = q ? brands.filter((b) => b.name.toLowerCase().includes(q)) : brands;
    if (sort === "alpha") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [brands, search, sort]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — mirrors the marketing pages */}
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <Link href="/" className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </Link>
        <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/brands" className="text-foreground hover:text-accent transition-colors">Brands</Link>
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Get started →</Link>
        </div>
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

        {/* Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-10">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search brands"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-4 py-2.5 bg-background border border-border-mid focus:border-foreground/60 focus:outline-none font-sans text-sm text-foreground placeholder:text-muted transition-colors"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSort("popular")}
              className={`px-4 py-2 font-sans text-[10px] tracking-widest uppercase transition-colors border ${sort === "popular" ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground hover:border-border-mid"}`}
            >
              Popular
            </button>
            <button
              onClick={() => setSort("alpha")}
              className={`px-4 py-2 font-sans text-[10px] tracking-widest uppercase transition-colors border ${sort === "alpha" ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground hover:border-border-mid"}`}
            >
              A–Z
            </button>
          </div>
          <span className="sm:ml-auto font-sans text-[10px] tracking-widest uppercase text-muted">
            {loading ? "loading…" : `${filtered.length.toLocaleString()} brand${filtered.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* Grid */}
        {loading ? (
          <p className="text-center font-display italic text-xl text-muted py-20">Loading the archive…</p>
        ) : filtered.length === 0 ? (
          <p className="text-center font-display italic text-xl text-muted py-20">No brands match that search.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
            {filtered.map((b) => <BrandCard key={b.name} brand={b} />)}
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

function BrandCard({ brand }: { brand: Brand }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div className="group relative aspect-[3/4] overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card hover:shadow-card-hover transition-all duration-300">
      {brand.imageUrl && !imgFailed ? (
        <Image
          src={brand.imageUrl}
          alt={brand.name}
          fill
          unoptimized
          className="object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          onError={() => setImgFailed(true)}
        />
      ) : null}
      {/* Dark gradient for name overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent pointer-events-none" />
      {/* Brand name + count */}
      <div className="absolute bottom-0 left-0 right-0 p-4 flex items-end justify-between gap-3">
        <h3 className="font-display font-light text-xl text-white leading-tight drop-shadow-sm">{brand.name}</h3>
        <span className="font-sans text-[9px] tracking-widest uppercase text-white/70 flex-shrink-0">
          {brand.count.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
