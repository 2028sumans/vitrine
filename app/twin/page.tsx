/**
 * /twin — "TwinFinder"
 *
 * Single-page flow:
 *   1. Upload zone (drag/drop or click). Only the hero shot matters — we embed it raw.
 *   2. Short "reading the room" beat so the reveal feels composed, not hurried.
 *   3. Split-screen reveal: uploaded image left, matched twin right. Tap alternates
 *      in the bottom rail to shuffle without re-uploading.
 *
 * Backed by /api/twin which runs FashionCLIP → Pinecone kNN → Algolia hydrate.
 */

"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { MobileMenu } from "../_components/MobileMenu";
import type { AlgoliaProduct } from "@/lib/algolia";

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "idle" | "reading" | "revealed" | "error";

interface TwinResult {
  twin:       AlgoliaProduct;
  alternates: AlgoliaProduct[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

// Downscale the upload to ~1024px on the long edge before base64-encoding.
// Keeps payloads small and the FashionCLIP preprocess step fast without
// throwing away visual signal.
async function fileToDownscaledBase64(
  file: File,
  maxEdge = 1024,
): Promise<{ base64: string; mimeType: string; previewUrl: string }> {
  const previewUrl = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new window.Image();
    i.onload  = () => resolve(i);
    i.onerror = reject;
    i.src     = previewUrl;
  });

  const scale  = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width  = Math.max(1, Math.round(img.width  * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, width, height);

  // JPEG quality 0.85 — plenty of signal for CLIP, ~80% payload savings over PNG.
  const dataUrl   = canvas.toDataURL("image/jpeg", 0.85);
  const [, base64] = dataUrl.split(",");
  return { base64, mimeType: "image/jpeg", previewUrl };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TwinPage() {
  const [phase,     setPhase]     = useState<Phase>("idle");
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [result,    setResult]    = useState<TwinResult | null>(null);
  const [twinIndex, setTwinIndex] = useState(0);
  const [errorMsg,  setErrorMsg]  = useState<string>("");
  const [dragging,  setDragging]  = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    if (uploadUrl) URL.revokeObjectURL(uploadUrl);
    setPhase("idle");
    setUploadUrl(null);
    setResult(null);
    setTwinIndex(0);
    setErrorMsg("");
  }, [uploadUrl]);

  const runTwin = useCallback(async (file: File) => {
    setErrorMsg("");
    setPhase("reading");
    try {
      const { base64, mimeType, previewUrl } = await fileToDownscaledBase64(file);
      setUploadUrl(previewUrl);

      const res = await fetch("/api/twin", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ image: { base64, mimeType } }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "request failed" }))) as { error?: string };
        throw new Error(error ?? "request failed");
      }
      const data = (await res.json()) as TwinResult;
      setResult(data);
      setTwinIndex(0);
      setPhase("revealed");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "something went sideways");
      setPhase("error");
    }
  }, []);

  const handleFile = useCallback(
    (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      runTwin(file);
    },
    [runTwin],
  );

  const candidates = result ? [result.twin, ...result.alternates] : [];
  const shownTwin  = candidates[twinIndex] ?? null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Nav — same fixed cream bar as /brands, /edit, /edits ───────────── */}
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <Link href="/" className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Get started →</Link>
          <Link href="/shop"   className="text-muted hover:text-foreground transition-colors">Shop</Link>
          <Link href="/brands" className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/dashboard", label: "Get started →" },
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1 pt-24 pb-24 px-8 max-w-7xl mx-auto w-full">

        {/* ── Idle: hero + drop zone ─────────────────────────────────────── */}
        {phase === "idle" && (
          <div className="flex flex-col items-center text-center fade-in-up">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
              New
            </p>
            <h1 className="font-display font-light text-6xl sm:text-7xl text-foreground leading-[1.05] mb-6">
              TwinFinder
            </h1>
            <p className="font-sans text-base text-muted-strong max-w-xl leading-relaxed mb-14">
              Upload a piece from anywhere — we&rsquo;ll find its small-batch,
              hand-made counterpart in the Muse catalog of independent labels.
            </p>

            <DropZone
              dragging={dragging}
              setDragging={setDragging}
              onFile={handleFile}
              onOpenPicker={() => fileInputRef.current?.click()}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />

            <p className="mt-6 font-sans text-[10px] tracking-widest uppercase text-muted">
              Tip — a clean shot on a plain background works best
            </p>
          </div>
        )}

        {/* ── Reading: soft wait state ───────────────────────────────────── */}
        {phase === "reading" && (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-5 text-center">
            <PulseDot />
            <p className="font-display font-light italic text-3xl text-foreground">
              Reading the room…
            </p>
            <p className="font-sans text-[10px] tracking-widest uppercase text-muted">
              Shape · Texture · Cut · Mood
            </p>
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {phase === "error" && (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-5 text-center max-w-xl mx-auto">
            <p className="font-display font-light text-4xl text-foreground">
              No twin found.
            </p>
            <p className="font-sans text-sm text-muted-strong">{errorMsg}</p>
            <button
              onClick={reset}
              className="mt-2 px-6 py-3 font-sans text-[10px] tracking-widest uppercase border border-border-mid text-foreground hover:bg-foreground hover:text-background transition-colors"
            >
              Try another →
            </button>
          </div>
        )}

        {/* ── Reveal ─────────────────────────────────────────────────────── */}
        {phase === "revealed" && shownTwin && uploadUrl && (
          <div className="max-w-6xl mx-auto">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-8 text-center">
              The twin
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-10">
              {/* Yours */}
              <div className="twin-pane">
                <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-3">
                  Yours
                </p>
                <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={uploadUrl}
                    alt="Your uploaded piece"
                    className="absolute inset-0 w-full h-full object-cover object-top"
                  />
                </div>
              </div>

              {/* Twin */}
              <div className="twin-pane">
                <p className="font-sans text-[10px] tracking-widest uppercase text-accent mb-3">
                  Its Twin
                </p>
                <a
                  href={shownTwin.product_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card hover:shadow-card-hover transition-all duration-300"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shownTwin.image_url}
                    alt={shownTwin.title}
                    className="absolute inset-0 w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
                  />
                </a>
                <div className="pt-3">
                  <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">
                    {shownTwin.brand}
                  </p>
                  <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-1">
                    {shownTwin.title}
                  </p>
                  {shownTwin.price != null && (
                    <span className="font-sans text-xs font-medium text-foreground">
                      {formatPrice(shownTwin.price)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Match line — soft, generic for v1. Future: Claude-crafted per-pair. */}
            <p className="mx-auto mt-12 max-w-xl text-center font-display font-light italic text-xl sm:text-2xl text-muted-strong leading-snug">
              Same silhouette. Different soul. Made by an independent label you can actually write to.
            </p>

            {/* Alternates rail */}
            {candidates.length > 1 && (
              <div className="mt-12">
                <p className="text-center font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
                  Other twins
                </p>
                <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:justify-center">
                  {candidates.map((p, i) => (
                    <button
                      key={p.objectID}
                      onClick={() => setTwinIndex(i)}
                      className={`relative aspect-[3/4] w-24 md:w-28 flex-shrink-0 snap-start overflow-hidden border transition-all duration-300 ${
                        i === twinIndex
                          ? "border-foreground opacity-100 shadow-card"
                          : "border-border opacity-50 hover:opacity-90"
                      }`}
                      aria-label={`Show twin ${i + 1}: ${p.title}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.image_url}
                        alt={p.title}
                        className="absolute inset-0 w-full h-full object-cover object-top"
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Actions — rectangular buttons match /dashboard, /edit */}
            <div className="mt-12 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <a
                href={shownTwin.product_url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors min-w-[220px] text-center"
              >
                Shop the twin →
              </a>
              <button
                onClick={reset}
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase border border-border-mid text-foreground hover:bg-foreground hover:text-background transition-colors min-w-[220px]"
              >
                Upload another
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── Footer — identical to /brands, /edit, /edits ───────────────────── */}
      <footer className="border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.18em] text-sm text-muted hover:text-foreground transition-colors">
            MUSE
          </Link>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <span>© 2025</span>
          </div>
        </div>
      </footer>

      {/* ── Reveal-pane motion — kept from the original, but muted ─────────── */}
      <style jsx>{`
        .twin-pane {
          animation: twinSlide 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .twin-pane:nth-child(1) { animation-name: twinSlideL; }
        .twin-pane:nth-child(2) { animation-name: twinSlideR; animation-delay: 120ms; }

        @keyframes twinSlideL {
          from { opacity: 0; transform: translate3d(-24px, 0, 0); }
          to   { opacity: 1; transform: translate3d(0, 0, 0); }
        }
        @keyframes twinSlideR {
          from { opacity: 0; transform: translate3d( 24px, 0, 0); }
          to   { opacity: 1; transform: translate3d(0, 0, 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .twin-pane,
          .twin-pane:nth-child(1),
          .twin-pane:nth-child(2) { animation: none; }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PulseDot() {
  return (
    <span
      className="inline-block h-3 w-3 rounded-full bg-foreground"
      style={{ animation: "twinPulse 1.1s ease-in-out infinite" }}
    >
      <style jsx>{`
        @keyframes twinPulse {
          0%, 100% { transform: scale(0.6); opacity: 0.4; }
          50%      { transform: scale(1.0); opacity: 1;   }
        }
      `}</style>
    </span>
  );
}

function DropZone({
  dragging,
  setDragging,
  onFile,
  onOpenPicker,
}: {
  dragging:     boolean;
  setDragging:  (v: boolean) => void;
  onFile:       (f: File | undefined) => void;
  onOpenPicker: () => void;
}) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFile(e.dataTransfer.files?.[0]);
      }}
      onClick={onOpenPicker}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenPicker(); }}
      className={`flex w-full max-w-xl cursor-pointer flex-col items-center justify-center border border-dashed px-10 py-16 transition-all duration-300 ${
        dragging
          ? "border-foreground bg-[rgba(42,51,22,0.06)] shadow-card"
          : "border-border-mid bg-[rgba(42,51,22,0.03)] hover:bg-[rgba(42,51,22,0.05)] hover:border-foreground/60"
      }`}
    >
      <p className="mb-2 font-display font-light text-3xl text-foreground">Drop a piece</p>
      <p className="font-sans text-[10px] tracking-widest uppercase text-muted">
        or click to upload · jpg · png · heic
      </p>
    </div>
  );
}
