"use client";

/**
 * /onboarding — one-shot taste-priming quiz.
 *
 * Surfaces once, right after first login. Two steps:
 *
 *   Step 1 — age: user taps one of 5 age-range pills.
 *   Step 2 — uploads: 1-2 outfit photos for each of 4 categories
 *            (casual, occasion, statement, accessories).
 *
 * On submit:
 *   → POST /api/onboarding/save with { userToken, ageRange, images[base64] }
 *   → server FashionCLIP-embeds each image and stores the averaged centroid
 *     in Supabase (see app/api/onboarding/save/route.ts)
 *   → redirect to /shop
 *
 * Design decisions baked in
 * -------------------------
 *   • In-flight state is cached in localStorage every change so a refresh /
 *     accidental tab close doesn't wipe an upload the user just dragged in.
 *     The cache is cleared on successful submit.
 *   • Categories are UX scaffolding only (user's Q3 answer) — the server
 *     averages ALL uploads into a single centroid regardless of category.
 *     So we don't send the category name to the API; we just show labels to
 *     help the user remember what to pull from Pinterest.
 *   • If the user is already onboarded we redirect them away in useEffect.
 *     The quiz is genuinely one-shot; revisiting /onboarding manually just
 *     bounces to /shop.
 *   • Aesthetic matches the rest of the site: cream bg + olive text,
 *     Cormorant Garamond display, Inter body, olive-pill accents.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";

// ── Config ────────────────────────────────────────────────────────────────────

interface AgeOption {
  key:   string;  // matches AGE_RANGE_KEYS in lib/onboarding-memory.ts
  label: string;  // display text on the pill
}

const AGES: readonly AgeOption[] = [
  { key: "age-13-18", label: "13–18" },
  { key: "age-18-25", label: "18–25" },
  { key: "age-25-32", label: "25–32" },
  { key: "age-32-40", label: "32–40" },
  { key: "age-40-60", label: "40–60" },
];

interface UploadCategory {
  key:     string;
  label:   string;
  hint:    string;
  /** Max uploads for this category. Server cap is 16 total; 2 × 4 = 8. */
  maxCount: number;
}

const CATEGORIES: readonly UploadCategory[] = [
  { key: "casual",      label: "Casual day",        hint: "How you dress when you're just being yourself.",              maxCount: 2 },
  { key: "occasion",    label: "Occasion / going out", hint: "Dinner, date, anything with a reservation.",                maxCount: 2 },
  { key: "statement",   label: "Statement",         hint: "The piece that makes someone ask where you got it.",           maxCount: 2 },
  { key: "accessories", label: "Accessories",       hint: "Bags, shoes, jewelry — the things that finish an outfit.",     maxCount: 2 },
];

/** localStorage key for the in-flight cache. Bump on schema changes. */
const CACHE_KEY = "muse-onboarding-draft-v1";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One uploaded image, stored base64-encoded so it survives refresh. */
interface UploadedImage {
  /** Stable per-image id — keyed for React renders + deletion. */
  id:       string;
  /** data: URL, suitable for <img src>. Also parsed server-side into base64. */
  dataUrl:  string;
  mimeType: string;
  /** Soft-size hint for quota math (base64 is ~33% larger than binary). */
  bytes:    number;
}

interface Draft {
  ageRange: string | null;
  /** category key → images[] */
  uploads:  Record<string, UploadedImage[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyDraft(): Draft {
  const uploads: Draft["uploads"] = {};
  for (const c of CATEGORIES) uploads[c.key] = [];
  return { ageRange: null, uploads };
}

function loadDraft(): Draft {
  if (typeof window === "undefined") return emptyDraft();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyDraft();
    // Fill in missing categories so the UI never sees a `undefined` bucket
    // after a category config change.
    const uploads: Draft["uploads"] = {};
    for (const c of CATEGORIES) {
      uploads[c.key] = Array.isArray(parsed.uploads?.[c.key]) ? parsed.uploads[c.key] : [];
    }
    return { ageRange: typeof parsed.ageRange === "string" ? parsed.ageRange : null, uploads };
  } catch {
    return emptyDraft();
  }
}

function saveDraft(d: Draft) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  } catch {
    // QuotaExceeded — uploads are big. Best-effort; the in-memory state is
    // the source of truth during this session.
  }
}

function clearDraft() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CACHE_KEY);
}

/**
 * Read a File, downscale to a max long-edge size, and return a JPEG data URL.
 *
 * Why
 * ---
 * Three problems this solves at once:
 *   1. iPhone screenshots are routinely 1290×2796 ≈ 5 MB raw. base64-encoded
 *      they're 7 MB; 4-8 of them in one POST body easily blows past Vercel's
 *      4.5 MB request limit on the Hobby tier.
 *   2. FashionCLIP processes at 224×224 anyway, so any resolution above
 *      ~512px on the long edge is wasted bytes. 1024 leaves headroom for
 *      higher-quality CLIP variants without bloating the payload.
 *   3. iOS Safari can decode HEIC into a canvas; canvas.toDataURL("image/jpeg")
 *      then exports as JPEG regardless of input format. So this function
 *      transparently converts HEIC → JPEG without us having to detect it.
 *
 * Falls back to the raw File-as-data-URL path on any error so a corrupted
 * image or an exotic format that the canvas can't load still has a chance
 * to flow through the original FileReader pipeline (and the server-side
 * embedder will surface the failure with proper logging).
 */
async function fileToDataUrl(file: File, maxDim = 1024): Promise<string> {
  // Fast path: read as a data URL via FileReader. We always have this as
  // a fallback so non-image-decodable bytes still produce a valid string.
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });

  // Try to load the data URL into an Image — this is what triggers the
  // browser's native decoder for HEIC, WebP, AVIF, etc. If it fails we
  // return the raw bytes and let the server tell the user what's wrong.
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = (ev) => reject(new Error(`image decode failed: ${String(ev)}`));
      i.src = rawDataUrl;
    });
  } catch {
    return rawDataUrl;
  }

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return rawDataUrl;

  // Skip resizing when already small — saves a canvas round-trip on tiny
  // crops or already-downsampled images.
  if (Math.max(w, h) <= maxDim) return rawDataUrl;

  const scale = maxDim / Math.max(w, h);
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  try {
    const canvas = document.createElement("canvas");
    canvas.width  = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return rawDataUrl;
    ctx.drawImage(img, 0, 0, tw, th);
    // Export as JPEG q=0.85 — visually indistinguishable from PNG for
    // photographic content, ~5x smaller, and FashionCLIP doesn't care.
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return rawDataUrl;
  }
}

/** Extract the raw base64 payload from a `data:image/...;base64,AAAA...` URL. */
function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, status: authStatus } = useSession();
  const userToken = session?.user?.id ?? "";

  const [step, setStep]           = useState<1 | 2>(1);
  const [draft, setDraftState]    = useState<Draft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  // Surface a non-blocking check that prevents re-doing the quiz if the user
  // got here by accident. We don't render anything until this resolves to
  // avoid a flash.
  const [alreadyDone, setAlreadyDone] = useState<boolean | null>(null);

  // Hydrate draft from localStorage on mount.
  useEffect(() => {
    setDraftState(loadDraft());
  }, []);

  // Redirect away if the user has already completed onboarding. Runs only
  // once we have a real userToken — during session loading it's "".
  useEffect(() => {
    if (!userToken) { setAlreadyDone(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/onboarding/status?userToken=${encodeURIComponent(userToken)}`);
        const j   = await res.json();
        if (cancelled) return;
        if (j?.completed) {
          setAlreadyDone(true);
          router.replace("/shop");
        } else {
          setAlreadyDone(false);
        }
      } catch {
        if (!cancelled) setAlreadyDone(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userToken, router]);

  // Wrap setDraft so every edit persists to localStorage immediately.
  const setDraft = useCallback((updater: (d: Draft) => Draft) => {
    setDraftState((prev) => {
      const next = updater(prev);
      saveDraft(next);
      return next;
    });
  }, []);

  // ── Upload handlers ─────────────────────────────────────────────────────

  const addImages = useCallback(async (catKey: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const cat = CATEGORIES.find((c) => c.key === catKey);
    if (!cat) return;

    const existing = draft.uploads[catKey] ?? [];
    const slotsLeft = Math.max(0, cat.maxCount - existing.length);
    if (slotsLeft === 0) return;

    const toAdd: UploadedImage[] = [];
    // Process files sequentially — files are small (<5 MB typical) and
    // FileReader is async, sequencing is fine and avoids a parallel-read
    // storm on low-end mobile.
    for (const file of Array.from(files).slice(0, slotsLeft)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await fileToDataUrl(file);
        toAdd.push({
          id:       `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          mimeType: file.type,
          bytes:    file.size,
        });
      } catch {
        // Silent skip — one bad file shouldn't tank the batch.
      }
    }

    if (toAdd.length === 0) return;
    setDraft((d) => ({
      ...d,
      uploads: { ...d.uploads, [catKey]: [...(d.uploads[catKey] ?? []), ...toAdd] },
    }));
  }, [draft.uploads, setDraft]);

  const removeImage = useCallback((catKey: string, id: string) => {
    setDraft((d) => ({
      ...d,
      uploads: { ...d.uploads, [catKey]: (d.uploads[catKey] ?? []).filter((u) => u.id !== id) },
    }));
  }, [setDraft]);

  // ── Derived ─────────────────────────────────────────────────────────────

  const totalImages = useMemo(
    () => Object.values(draft.uploads).reduce((n, arr) => n + arr.length, 0),
    [draft.uploads],
  );

  const canAdvanceFromAge = !!draft.ageRange;
  const canSubmit = canAdvanceFromAge && totalImages >= 1;

  // ── Submit ──────────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    if (!canSubmit || !userToken) return;
    setError(null);
    setSubmitting(true);
    try {
      const images = Object.values(draft.uploads)
        .flat()
        .map((u) => ({ base64: dataUrlToBase64(u.dataUrl), mimeType: u.mimeType }));

      const res = await fetch("/api/onboarding/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userToken, ageRange: draft.ageRange, images }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `save failed (${res.status})`);
      }
      clearDraft();
      router.replace("/shop");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again?");
      setSubmitting(false);
    }
  }, [canSubmit, draft, userToken, router]);

  // Skip the upload step. Keeps the age they already picked but stores
  // no upload centroid — ranking falls back to just the age prior. Same
  // endpoint, `skip: true` flag routes it down the no-embed path.
  const skipUploads = useCallback(async () => {
    if (!canAdvanceFromAge || !userToken || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userToken, ageRange: draft.ageRange, skip: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `skip failed (${res.status})`);
      }
      clearDraft();
      router.replace("/shop");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't skip. Try again?");
      setSubmitting(false);
    }
  }, [canAdvanceFromAge, draft.ageRange, userToken, submitting, router]);

  // ── Render ──────────────────────────────────────────────────────────────

  // Pre-session / pre-status-check: render nothing to avoid flash.
  if (authStatus === "loading" || alreadyDone === null) {
    return <div className="min-h-screen bg-background" />;
  }

  // Must be signed in. We bounce to /login if not — once auth lands it'll
  // redirect back here via the standard NextAuth callback flow.
  if (authStatus === "unauthenticated" || !userToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="font-display font-light text-4xl text-foreground mb-4">Sign in first.</h1>
          <p className="font-sans text-base text-muted-strong mb-8 leading-relaxed">
            We personalize your feed from the moment you land — so we need to know who you are before we take you through the quiz.
          </p>
          <Link
            href="/login"
            className="inline-block px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors"
          >
            Sign in →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Slim top bar */}
      <header className="px-6 py-4 border-b border-border-mid">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground">
            MUSE
          </Link>
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
            Onboarding · Step {step} of 2
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-16">
        {step === 1 && (
          <StepAge
            value={draft.ageRange}
            onChange={(k) => setDraft((d) => ({ ...d, ageRange: k }))}
            onNext={() => setStep(2)}
            canAdvance={canAdvanceFromAge}
          />
        )}

        {step === 2 && (
          <StepUploads
            uploads={draft.uploads}
            onAdd={addImages}
            onRemove={removeImage}
            totalImages={totalImages}
            onBack={() => setStep(1)}
            onSubmit={submit}
            onSkip={skipUploads}
            canSubmit={canSubmit}
            submitting={submitting}
            error={error}
          />
        )}
      </main>
    </div>
  );
}

// ── Step components ───────────────────────────────────────────────────────────

function StepAge(props: {
  value:      string | null;
  onChange:   (k: string) => void;
  onNext:     () => void;
  canAdvance: boolean;
}) {
  return (
    <section>
      <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-5">
        About you
      </p>
      <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-5">
        How old are you?
      </h1>
      <p className="font-display font-light italic text-xl text-muted-strong mb-12 max-w-xl">
        Age is one of the strongest shortcuts to taste. We use it as a starting point —
        your uploads and likes refine everything from here.
      </p>

      <div className="flex flex-wrap gap-3 mb-14">
        {AGES.map((a) => {
          const active = props.value === a.key;
          return (
            <button
              key={a.key}
              onClick={() => props.onChange(a.key)}
              aria-pressed={active}
              className={`px-7 py-3.5 font-sans text-[12px] tracking-widest uppercase border transition-colors ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : "border-border-mid text-muted-strong hover:text-foreground hover:border-foreground/60"
              }`}
            >
              {a.label}
            </button>
          );
        })}
      </div>

      <button
        onClick={props.onNext}
        disabled={!props.canAdvance}
        className="px-8 py-3.5 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Continue →
      </button>
    </section>
  );
}

function StepUploads(props: {
  uploads:     Draft["uploads"];
  onAdd:       (catKey: string, files: FileList | null) => void;
  onRemove:    (catKey: string, id: string) => void;
  totalImages: number;
  onBack:      () => void;
  onSubmit:    () => void;
  /** Keeps the age they picked on step 1, skips the uploads. Taste ranking
   *  falls back to just the age centroid. */
  onSkip:      () => void;
  canSubmit:   boolean;
  submitting:  boolean;
  error:       string | null;
}) {
  return (
    <section>
      <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-5">
        Your taste
      </p>
      <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-5">
        Show us one or two outfits.
      </h1>
      <p className="font-display font-light italic text-xl text-muted-strong mb-10 max-w-2xl">
        A screenshot from Pinterest, a photo from your camera roll — anything that feels like <em>your</em> taste.
      </p>
      <p className="font-sans text-sm text-muted-strong mb-12 max-w-2xl leading-relaxed">
        Try to cover a few different moods. You don&apos;t have to fill every category —
        even one great image is enough to start.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 mb-14">
        {CATEGORIES.map((c) => (
          <CategoryCard
            key={c.key}
            category={c}
            images={props.uploads[c.key] ?? []}
            onAdd={(files) => props.onAdd(c.key, files)}
            onRemove={(id) => props.onRemove(c.key, id)}
          />
        ))}
      </div>

      {props.error && (
        <p className="font-sans text-sm text-[#7a2a2a] mb-5">
          {props.error}
        </p>
      )}

      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={props.onBack}
          disabled={props.submitting}
          className="px-6 py-3 font-sans text-[10px] tracking-widest uppercase border border-border-mid text-muted hover:text-foreground hover:border-foreground transition-colors disabled:opacity-40"
        >
          ← Back
        </button>
        <button
          onClick={props.onSubmit}
          disabled={!props.canSubmit || props.submitting}
          className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {props.submitting ? "Building your taste profile…" : "Build my taste profile →"}
        </button>
        <span className="ml-auto font-sans text-[10px] tracking-widest uppercase text-muted">
          {props.totalImages} uploaded
        </span>
      </div>

      {/* Skip — small, secondary, visually de-emphasised. Sits below the
          primary action row so it reads as a deliberate escape hatch, not
          a competing CTA. Leaves the age prior in place; the feed just
          won't have a personal upload signal to lean on. */}
      <div className="mt-8 pt-6 border-t border-border-mid">
        <button
          type="button"
          onClick={props.onSkip}
          disabled={props.submitting}
          className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors underline underline-offset-4 decoration-border-mid hover:decoration-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {props.submitting ? "…" : "Skip for now — I'll upload later"}
        </button>
        <p className="mt-3 font-sans text-xs text-muted leading-relaxed max-w-xl">
          We&apos;ll build your feed from your age range and what you interact with.
          Your personal uploads help it get sharper — you can add them anytime from settings.
        </p>
      </div>
    </section>
  );
}

function CategoryCard(props: {
  category: UploadCategory;
  images:   UploadedImage[];
  onAdd:    (files: FileList | null) => void;
  onRemove: (id: string) => void;
}) {
  const { category, images, onAdd, onRemove } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const full = images.length >= category.maxCount;

  return (
    <div className="border border-border-mid p-5">
      <h3 className="font-display font-light text-2xl text-foreground mb-1">
        {category.label}
      </h3>
      <p className="font-sans text-sm text-muted-strong mb-5 leading-relaxed">
        {category.hint}
      </p>

      {/* Thumbnails + add slot */}
      <div className="flex gap-3 flex-wrap">
        {images.map((img) => (
          <div key={img.id} className="relative w-24 h-32">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.dataUrl}
              alt=""
              className="w-full h-full object-cover border border-border-mid"
            />
            <button
              onClick={() => onRemove(img.id)}
              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-foreground text-background font-sans text-[10px] leading-none flex items-center justify-center hover:bg-accent transition-colors"
              title="Remove"
              aria-label="Remove image"
            >
              ×
            </button>
          </div>
        ))}

        {!full && (
          <button
            onClick={() => inputRef.current?.click()}
            className="w-24 h-32 border border-dashed border-border-mid flex flex-col items-center justify-center gap-1 hover:border-foreground hover:bg-[rgba(42,51,22,0.04)] transition-colors"
          >
            <span className="font-display font-light text-3xl text-muted leading-none">+</span>
            <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
              Add
            </span>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onAdd(e.target.files);
          // Reset so the same file re-selection still fires onChange.
          e.target.value = "";
        }}
      />

      <p className="mt-3 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
        {images.length}/{category.maxCount}
      </p>
    </div>
  );
}
