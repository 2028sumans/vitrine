/**
 * /twin — "Find its Twin"
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
import Image from "next/image";
import Link from "next/link";
import { MobileMenu } from "../_components/MobileMenu";
import type { AlgoliaProduct } from "@/lib/algolia";

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "idle" | "reading" | "revealed" | "error";

interface TwinResult {
  twin:       AlgoliaProduct;
  alternates: AlgoliaProduct[];
}

// ── Palette (keep inline — matches the deep-olive hero on /) ─────────────────

const BG   = "#EDE5D0"; // warm cream
const INK  = "#333E1D"; // deep olive
const MUTE = "#333E1D99";

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
  const [phase,       setPhase]       = useState<Phase>("idle");
  const [uploadUrl,   setUploadUrl]   = useState<string | null>(null);
  const [result,      setResult]      = useState<TwinResult | null>(null);
  const [twinIndex,   setTwinIndex]   = useState(0);
  const [errorMsg,    setErrorMsg]    = useState<string>("");
  const [dragging,    setDragging]    = useState(false);
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

  // All candidates (twin + alternates), cycled by twinIndex in the UI rail.
  const candidates = result ? [result.twin, ...result.alternates] : [];
  const shownTwin  = candidates[twinIndex] ?? null;

  return (
    <main style={{ backgroundColor: BG, color: INK, minHeight: "100vh" }}>
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-5 md:px-10">
        <Link href="/" className="font-serif text-2xl tracking-tight">
          muse
        </Link>
        <nav className="hidden items-center gap-7 font-sans text-sm sm:flex">
          <Link href="/shop"   className="hover:opacity-70">Shop</Link>
          <Link href="/brands" className="hover:opacity-70">Brands</Link>
          <Link href="/edit"   className="hover:opacity-70">Your shortlist</Link>
          <Link
            href="/dashboard"
            className="rounded-full px-4 py-2 text-white transition hover:opacity-90"
            style={{ backgroundColor: INK }}
          >
            Get started →
          </Link>
        </nav>
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

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      {phase === "idle" && (
        <section className="mx-auto flex max-w-4xl flex-col items-center px-6 py-10 text-center md:py-16">
          <p
            className="mb-4 font-sans text-xs uppercase tracking-[0.25em]"
            style={{ color: MUTE }}
          >
            new
          </p>
          <h1 className="mb-5 font-serif text-5xl leading-[1.05] md:text-7xl">
            Find its Twin
          </h1>
          <p
            className="mb-10 max-w-xl font-sans text-base md:text-lg"
            style={{ color: MUTE }}
          >
            Every basic has a Twin. Upload a piece — from anywhere — and we&rsquo;ll
            find its small-batch, hand-made counterpart from our catalog of independent labels.
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

          <p className="mt-6 font-sans text-xs" style={{ color: MUTE }}>
            Tip: a single clean shot of the garment on a plain background works best.
          </p>
        </section>
      )}

      {/* ── Reading the room beat ───────────────────────────────────────── */}
      {phase === "reading" && (
        <section className="mx-auto flex min-h-[60vh] max-w-4xl flex-col items-center justify-center gap-4 px-6 text-center">
          <PulseDot />
          <p className="font-serif text-2xl md:text-3xl">reading the room…</p>
          <p className="font-sans text-sm" style={{ color: MUTE }}>
            shape, texture, cut, mood
          </p>
        </section>
      )}

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {phase === "error" && (
        <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="font-serif text-3xl">no twin found.</p>
          <p className="font-sans text-sm" style={{ color: MUTE }}>{errorMsg}</p>
          <button
            onClick={reset}
            className="rounded-full border px-6 py-2 font-sans text-sm uppercase tracking-widest transition hover:opacity-70"
            style={{ borderColor: INK }}
          >
            try another
          </button>
        </section>
      )}

      {/* ── Reveal ──────────────────────────────────────────────────────── */}
      {phase === "revealed" && shownTwin && uploadUrl && (
        <section className="mx-auto max-w-6xl px-6 pb-20 md:px-10">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-0">
            {/* Yours */}
            <figure className="twin-pane flex flex-col">
              <Caption label="Yours" />
              <div className="relative aspect-[3/4] w-full overflow-hidden bg-black/5">
                {/* next/image needs width/height for remote URLs; use fill instead */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={uploadUrl}
                  alt="Your uploaded piece"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            </figure>

            {/* Twin */}
            <figure className="twin-pane flex flex-col">
              <Caption label="Its Twin" accent />
              <Link
                href={shownTwin.product_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative block aspect-[3/4] w-full overflow-hidden bg-black/5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shownTwin.image_url}
                  alt={shownTwin.title}
                  className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.02]"
                />
              </Link>
              <figcaption className="mt-3 flex items-end justify-between gap-4">
                <div>
                  <p className="font-sans text-xs uppercase tracking-[0.2em]" style={{ color: MUTE }}>
                    {shownTwin.brand}
                  </p>
                  <p className="mt-1 font-serif text-lg leading-snug">
                    {shownTwin.title}
                  </p>
                </div>
                <p className="whitespace-nowrap font-sans text-sm" style={{ color: MUTE }}>
                  {formatPrice(shownTwin.price)}
                </p>
              </figcaption>
            </figure>
          </div>

          {/* Match line — soft, generic for v1. Future: Claude-crafted per-pair. */}
          <p
            className="mx-auto mt-10 max-w-xl text-center font-serif text-lg leading-relaxed md:text-xl"
            style={{ color: INK }}
          >
            Same silhouette. Different soul. Made by an independent label you can
            actually write to.
          </p>

          {/* Alternates rail */}
          {candidates.length > 1 && (
            <div className="mt-10">
              <p
                className="mb-3 text-center font-sans text-xs uppercase tracking-[0.2em]"
                style={{ color: MUTE }}
              >
                other twins
              </p>
              <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:justify-center">
                {candidates.map((p, i) => (
                  <button
                    key={p.objectID}
                    onClick={() => setTwinIndex(i)}
                    className={`relative aspect-[3/4] w-24 flex-shrink-0 snap-start overflow-hidden transition md:w-28 ${
                      i === twinIndex ? "opacity-100" : "opacity-40 hover:opacity-80"
                    }`}
                    style={{
                      outline: i === twinIndex ? `2px solid ${INK}` : "none",
                      outlineOffset: "2px",
                    }}
                    aria-label={`Show twin ${i + 1}: ${p.title}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.image_url}
                      alt={p.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-12 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href={shownTwin.product_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full px-7 py-3 font-sans text-sm uppercase tracking-widest text-white transition hover:opacity-90"
              style={{ backgroundColor: INK }}
            >
              shop the twin →
            </Link>
            <button
              onClick={reset}
              className="rounded-full border px-7 py-3 font-sans text-sm uppercase tracking-widest transition hover:opacity-70"
              style={{ borderColor: INK, color: INK }}
            >
              upload another
            </button>
          </div>
        </section>
      )}

      {/* ── Styles ──────────────────────────────────────────────────────── */}
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
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Caption({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <p
      className="mb-3 font-sans text-xs uppercase tracking-[0.25em]"
      style={{ color: accent ? INK : MUTE, fontWeight: accent ? 600 : 400 }}
    >
      {label}
    </p>
  );
}

function PulseDot() {
  return (
    <span
      className="inline-block h-3 w-3 rounded-full"
      style={{ backgroundColor: INK, animation: "twinPulse 1.1s ease-in-out infinite" }}
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
      className={`flex w-full max-w-xl cursor-pointer flex-col items-center justify-center rounded-sm border-2 border-dashed px-10 py-14 transition ${
        dragging ? "opacity-60" : "hover:opacity-75"
      }`}
      style={{ borderColor: INK }}
    >
      <p className="mb-1 font-serif text-2xl">drop a piece</p>
      <p className="font-sans text-xs" style={{ color: MUTE }}>
        or click to upload — jpg, png, heic
      </p>
    </div>
  );
}
