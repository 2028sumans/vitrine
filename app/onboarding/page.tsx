"use client";

/**
 * /onboarding — one-shot taste-priming quiz.
 *
 * Surfaces once, right after first login. Two steps:
 *
 *   Step 1 — age:   user taps one of 4 age-range pills (13-18, 18-25,
 *                   25-32, 32+).
 *   Step 2 — pairs: user taps through up to 80 "this or this" pairs of
 *                   products, picking one (or neither). Target = 50
 *                   positive picks; auto-submits when reached. Each pair
 *                   contrasts two products from the same category on one
 *                   of the five style axes (formality, minimalism, edge,
 *                   romance, drape) so picks span the full taste space.
 *
 * On submit:
 *   → POST /api/onboarding/save with { userToken, ageRange, picks }
 *   → server reads each picked + rejected product's pre-computed CLIP
 *     vector from Pinecone, computes preference centroid:
 *         normalize(avg(picked) − 0.3 × avg(rejected))
 *   → centroid persists in user_onboarding.upload_centroid (column name
 *     retained for backward compat — see save route header)
 *   → redirect to /shop
 *
 * Why pairs instead of photo uploads
 * ----------------------------------
 *   The previous flow asked users to upload 1-8 outfit photos which got
 *   FashionCLIP-embedded server-side. Two problems killed it: (1) photo-
 *   finding friction → most users skipped or dropped off; (2) casual
 *   snapshots embed lighting + background + framing alongside actual
 *   style, all noise. Pairs fix both: 50 taps takes ~2 min, vectors come
 *   from clean catalog photography (low noise), AND we get a negative
 *   signal from the rejected side that photos couldn't provide.
 *
 * Resume support
 * --------------
 *   In-flight state caches to localStorage on every change. Includes the
 *   fetched pairs themselves (not just picks) so a refresh restores the
 *   exact same gauntlet — picks made before the refresh stay attributed
 *   to the same pair sequence rather than getting orphaned against a
 *   freshly-randomized server fetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";

// ── Config ────────────────────────────────────────────────────────────────────

interface AgeOption {
  key:   string;  // matches AGE_RANGE_KEYS in lib/onboarding-memory.ts
  label: string;
}

const AGES: readonly AgeOption[] = [
  { key: "age-13-18",   label: "13–18" },
  { key: "age-18-25",   label: "18–25" },
  { key: "age-25-32",   label: "25–32" },
  { key: "age-32-plus", label: "32+"   },
];

/** Number of positive picks required before we auto-submit. The /api/onboarding/pairs
 *  endpoint returns ~80 pairs so the user has buffer for "neither" clicks. */
const TARGET_PICKS = 50;

/** localStorage key for the in-flight cache. v2 = pair-gauntlet schema (v1
 *  was the photo-upload schema; bumping the key means stale v1 drafts get
 *  cleanly discarded rather than corrupting the new flow). */
const CACHE_KEY = "muse-onboarding-draft-v2";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PairProduct {
  objectID:  string;
  title:     string;
  brand?:    string;
  image_url: string;
  price?:    number | null;
}

interface Pair {
  id:       string;
  axis:     string;
  category: string;
  a:        PairProduct;
  b:        PairProduct;
}

interface Pick {
  pickedId:   string;
  rejectedId: string;
}

interface Draft {
  ageRange: string | null;
  /** The full gauntlet, fetched once from /api/onboarding/pairs and cached
   *  so refresh during the flow restores exact same pair sequence. */
  pairs:    Pair[];
  picks:    Pick[];
  /** Index into `pairs` of the currently-shown pair. */
  pairIdx:  number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyDraft(): Draft {
  return { ageRange: null, pairs: [], picks: [], pairIdx: 0 };
}

function loadDraft(): Draft {
  if (typeof window === "undefined") return emptyDraft();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyDraft();
    return {
      ageRange: typeof parsed.ageRange === "string" ? parsed.ageRange : null,
      pairs:    Array.isArray(parsed.pairs)         ? parsed.pairs    : [],
      picks:    Array.isArray(parsed.picks)         ? parsed.picks    : [],
      pairIdx:  typeof parsed.pairIdx === "number"  ? parsed.pairIdx  : 0,
    };
  } catch {
    return emptyDraft();
  }
}

function saveDraft(d: Draft) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  } catch {
    // QuotaExceeded — pair cache is ~150KB which is well under 5MB but be
    // defensive. In-memory state is the source of truth during this session.
  }
}

function clearDraft() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CACHE_KEY);
}

function formatPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, status: authStatus } = useSession();
  const userToken = session?.user?.id ?? "";

  const [step, setStep]             = useState<1 | 2>(1);
  const [draft, setDraftState]      = useState<Draft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [pairsLoading, setPairsLoading] = useState(false);
  const [pairsError, setPairsError]     = useState<string | null>(null);
  // Onboarding gate. We don't render anything until this resolves to avoid a
  // flash of the quiz for users who already onboarded.
  const [alreadyDone, setAlreadyDone] = useState<boolean | null>(null);

  // Hydrate draft from localStorage on mount.
  useEffect(() => {
    setDraftState(loadDraft());
  }, []);

  // Onboarding-status gate: redirect if user already finished the quiz.
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

  // Wrap setDraft so every edit persists to localStorage.
  const setDraft = useCallback((updater: (d: Draft) => Draft) => {
    setDraftState((prev) => {
      const next = updater(prev);
      saveDraft(next);
      return next;
    });
  }, []);

  // Fetch the pair gauntlet when the user advances to step 2 and we don't
  // already have pairs cached. Cache hit = the user resumed mid-flow; we
  // keep going from the same pair sequence.
  //
  // In-flight gating uses a ref, NOT pairsLoading state. With state in deps,
  // calling setPairsLoading(true) inside the effect would re-trigger the
  // effect, run cleanup (setting cancelled=true), and the in-flight fetch's
  // result would be discarded — leaving the page stuck on "Building your
  // gauntlet…" forever even though the request had succeeded. The ref
  // sidesteps the dep cycle: state still drives UI, but the fetch lifecycle
  // is decoupled from React's render loop.
  const fetchInFlightRef = useRef(false);
  useEffect(() => {
    if (step !== 2) return;
    if (draft.pairs.length > 0) return; // already fetched / restored from cache
    if (fetchInFlightRef.current) return;

    fetchInFlightRef.current = true;
    let cancelled = false;
    setPairsLoading(true);
    setPairsError(null);
    (async () => {
      try {
        const res = await fetch("/api/onboarding/pairs", { method: "GET" });
        if (!res.ok) throw new Error(`pairs fetch failed (${res.status})`);
        const j = await res.json();
        const pairs: Pair[] = Array.isArray(j?.pairs) ? j.pairs : [];
        if (cancelled) return;
        if (pairs.length === 0) {
          setPairsError("Couldn't load the pair gauntlet. Try refreshing — or skip for now.");
          return;
        }
        setDraft((d) => ({ ...d, pairs, pairIdx: 0, picks: [] }));
      } catch (err) {
        if (!cancelled) {
          setPairsError(err instanceof Error ? err.message : "Pair fetch failed");
        }
      } finally {
        fetchInFlightRef.current = false;
        if (!cancelled) setPairsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, draft.pairs.length, setDraft]);

  // ── Pair handlers ─────────────────────────────────────────────────────

  /** Submit the gauntlet (auto-called when target hit, or via "Wrap up" CTA). */
  const submit = useCallback(async (override?: { picks?: Pick[] }) => {
    if (!userToken) return;
    if (submitting) return;
    const picksToSend = override?.picks ?? draft.picks;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          userToken,
          ageRange: draft.ageRange,
          picks:    picksToSend,
        }),
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
  }, [draft.ageRange, draft.picks, userToken, submitting, router]);

  /** Explicit skip — keeps age, no centroid. Same fallback as path C in save. */
  const skipPairs = useCallback(async () => {
    if (!userToken || submitting) return;
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
  }, [draft.ageRange, userToken, submitting, router]);

  /** Record a positive pick. Auto-submits when picks count hits TARGET_PICKS. */
  const handlePick = useCallback((pickedId: string, rejectedId: string) => {
    setDraft((d) => {
      const newPicks: Pick[] = [...d.picks, { pickedId, rejectedId }];
      const next: Draft = {
        ...d,
        picks:   newPicks,
        pairIdx: d.pairIdx + 1,
      };
      // Auto-submit when target reached. Use the freshly-built picks so we
      // don't race against the React state update inside submit().
      if (newPicks.length >= TARGET_PICKS) {
        // Defer to next tick so this state update commits first.
        queueMicrotask(() => submit({ picks: newPicks }));
      }
      return next;
    });
  }, [setDraft, submit]);

  /** "Neither" — skip this pair without contributing to picks. Just advances
   *  the cursor. If the cursor runs past the buffer, the UI shows the wrap-up CTA. */
  const handleNeither = useCallback(() => {
    setDraft((d) => ({ ...d, pairIdx: d.pairIdx + 1 }));
  }, [setDraft]);

  // ── Derived ─────────────────────────────────────────────────────────────

  const canAdvanceFromAge = !!draft.ageRange;
  const currentPair       = draft.pairs[draft.pairIdx] ?? null;
  const pickCount         = draft.picks.length;
  const exhausted         = draft.pairs.length > 0 && draft.pairIdx >= draft.pairs.length;
  const reachedTarget     = pickCount >= TARGET_PICKS;

  // Preload the next few pairs' images so taps feel instant. Without this,
  // the browser fetches each pair's images on demand when they enter the
  // DOM, producing a visible desync where one image pops in before the
  // other (different file sizes = different download times). Three pairs
  // ahead covers the typical click-then-neither-then-click sequence too.
  // Uses native Image() to populate the browser cache without mounting
  // anything in the DOM — pure side-effect, doesn't trigger React renders.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (draft.pairs.length === 0) return;
    const ahead = draft.pairs.slice(draft.pairIdx + 1, draft.pairIdx + 4);
    for (const p of ahead) {
      const aImg = new window.Image();
      aImg.src = p.a.image_url;
      const bImg = new window.Image();
      bImg.src = p.b.image_url;
    }
  }, [draft.pairs, draft.pairIdx]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (authStatus === "loading" || alreadyDone === null) {
    return <div className="min-h-screen bg-background" />;
  }

  if (authStatus === "unauthenticated" || !userToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="font-display font-light text-4xl text-foreground mb-4">Sign in first.</h1>
          <p className="font-sans text-base text-muted-strong mb-8 leading-relaxed">
            We personalize your feed from the moment you land — so we need to know who you are
            before we take you through the quiz.
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
      <header className="px-6 py-4 border-b border-border-mid">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground">
            MUSE
          </Link>
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
            Onboarding · Step {step} of 2
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 sm:py-16">
        {step === 1 && (
          <StepAge
            value={draft.ageRange}
            onChange={(k) => setDraft((d) => ({ ...d, ageRange: k }))}
            onNext={() => setStep(2)}
            canAdvance={canAdvanceFromAge}
          />
        )}

        {step === 2 && (
          <StepPairPicks
            currentPair={currentPair}
            pickCount={pickCount}
            target={TARGET_PICKS}
            exhausted={exhausted}
            reachedTarget={reachedTarget}
            pairsLoading={pairsLoading}
            pairsError={pairsError}
            onPick={handlePick}
            onNeither={handleNeither}
            onBack={() => setStep(1)}
            onSubmit={() => submit()}
            onSkip={skipPairs}
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
        the picks you make next refine it from there.
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

function StepPairPicks(props: {
  currentPair:    Pair | null;
  pickCount:      number;
  target:         number;
  exhausted:      boolean;
  reachedTarget:  boolean;
  pairsLoading:   boolean;
  pairsError:     string | null;
  onPick:         (pickedId: string, rejectedId: string) => void;
  onNeither:      () => void;
  onBack:         () => void;
  onSubmit:       () => void;
  onSkip:         () => void;
  submitting:     boolean;
  error:          string | null;
}) {
  const {
    currentPair, pickCount, target, exhausted, reachedTarget,
    pairsLoading, pairsError, onPick, onNeither, onBack, onSubmit, onSkip,
    submitting, error,
  } = props;

  const progressPct = Math.min(100, Math.round((pickCount / target) * 100));

  // ── Loading / error states ─────────────────────────────────────────────
  if (pairsLoading || (!currentPair && !pairsError && !exhausted)) {
    return (
      <section className="text-center py-20">
        <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-5">
          Your taste
        </p>
        <h1 className="font-display font-light text-4xl sm:text-5xl text-foreground leading-tight mb-3">
          Building your gauntlet…
        </h1>
        <p className="font-display font-light italic text-lg text-muted-strong mb-10">
          One sec — pulling fifty contrasting pieces from across the catalog.
        </p>
      </section>
    );
  }

  if (pairsError) {
    return (
      <section>
        <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-5">
          Your taste
        </p>
        <h1 className="font-display font-light text-4xl text-foreground leading-tight mb-5">
          Couldn&apos;t load the pairs.
        </h1>
        <p className="font-sans text-base text-muted-strong mb-10 max-w-xl">
          {pairsError}
        </p>
        <button
          onClick={onSkip}
          disabled={submitting}
          className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {submitting ? "…" : "Skip and continue →"}
        </button>
      </section>
    );
  }

  // ── Reached target OR exhausted buffer → wrap-up screen ────────────────
  if (reachedTarget || exhausted) {
    const wrapUpHeading =
      reachedTarget
        ? "Locked in."
        : pickCount >= 10
          ? "Good enough — let's go."
          : "Not many picks landed.";
    const wrapUpBody =
      reachedTarget
        ? `${pickCount} picks. We've got a strong read on your taste.`
        : pickCount >= 10
          ? `${pickCount} picks made. Your feed will sharpen further as you browse.`
          : `Only ${pickCount} positive ${pickCount === 1 ? "pick" : "picks"} made — your feed will lean on age and your real-world browsing to learn.`;

    return (
      <section className="text-center py-12">
        <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-5">
          Your taste
        </p>
        <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-5">
          {wrapUpHeading}
        </h1>
        <p className="font-display font-light italic text-xl text-muted-strong mb-12 max-w-xl mx-auto">
          {wrapUpBody}
        </p>

        {error && (
          <p className="font-sans text-sm text-[#7a2a2a] mb-5">{error}</p>
        )}

        <button
          onClick={onSubmit}
          disabled={submitting}
          className="px-10 py-4 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving your taste profile…" : "Take me to my feed →"}
        </button>
      </section>
    );
  }

  // ── Active gauntlet ───────────────────────────────────────────────────
  return (
    <section>
      {/* Progress bar */}
      <div className="mb-10">
        <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-3">
          Your taste · {pickCount} of {target} picks
        </p>
        <div className="h-[2px] w-full bg-border-mid overflow-hidden">
          <div
            className="h-full bg-foreground transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <h1 className="font-display font-light text-4xl sm:text-5xl text-foreground leading-tight mb-3">
        Which feels more <em className="italic">you</em>?
      </h1>
      <p className="font-display font-light italic text-lg text-muted-strong mb-10 max-w-xl">
        Quick taps. Don&apos;t overthink it. We&apos;re reading the gut, not the catalog.
      </p>

      {currentPair && (
        <PairChoice
          pair={currentPair}
          onPick={onPick}
          submitting={submitting}
        />
      )}

      {/* Neither — italic display font, larger so it reads as a real
          alternative rather than a hidden escape hatch. Still
          underlined-on-hover, not a solid button, so it doesn't compete
          visually with the two product cards above (the cards are still
          the primary action). */}
      <div className="mt-10 flex justify-center">
        <button
          onClick={onNeither}
          disabled={submitting}
          className="font-display italic font-light text-3xl sm:text-4xl text-muted-strong hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Skip this pair — neither feels right"
        >
          neither →
        </button>
      </div>

      {error && (
        <p className="font-sans text-sm text-[#7a2a2a] mt-8 text-center">{error}</p>
      )}

      {/* Footer controls — back to age (secondary outline) and the wrap-up /
          skip CTA (primary olive). Both are real buttons now in MUSE's
          olive palette so they read as tappable affordances, not buried
          underlines. The asymmetry between secondary border and primary
          fill mirrors the rest of the site's button hierarchy. */}
      <div className="mt-14 pt-6 border-t border-border-mid flex items-center gap-4 flex-wrap">
        <button
          onClick={onBack}
          disabled={submitting}
          className="px-7 py-3.5 font-sans text-[10px] tracking-widest uppercase border border-foreground text-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Back to age
        </button>

        {/* Wrap-up early CTA — only when user has at least a few picks so
            the saved centroid won't be junk. Below 5 picks we show "Skip
            for now" since that's the more honest framing. Both share the
            primary olive button shape. */}
        {pickCount >= 5 ? (
          <button
            onClick={onSubmit}
            disabled={submitting}
            className="px-8 py-3.5 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Saving…" : `I'm done — wrap up with ${pickCount} →`}
          </button>
        ) : (
          <button
            onClick={onSkip}
            disabled={submitting}
            className="px-8 py-3.5 font-sans text-[10px] tracking-widest uppercase bg-foreground text-background hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "…" : "Skip for now →"}
          </button>
        )}
      </div>
    </section>
  );
}

function PairChoice(props: {
  pair:       Pair;
  onPick:     (pickedId: string, rejectedId: string) => void;
  submitting: boolean;
}) {
  const { pair, onPick, submitting } = props;
  return (
    <div className="grid grid-cols-2 gap-4 sm:gap-6 max-w-3xl mx-auto">
      <ProductChoiceCard
        product={pair.a}
        onClick={() => onPick(pair.a.objectID, pair.b.objectID)}
        disabled={submitting}
      />
      <ProductChoiceCard
        product={pair.b}
        onClick={() => onPick(pair.b.objectID, pair.a.objectID)}
        disabled={submitting}
      />
    </div>
  );
}

function ProductChoiceCard(props: {
  product:  PairProduct;
  onClick:  () => void;
  disabled: boolean;
}) {
  const { product, onClick, disabled } = props;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group block text-left w-full disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
      aria-label={`Pick ${product.brand ?? ""} ${product.title}`}
    >
      {/* Image-only frame + soft shadow + hover-grow + image-only border —
          mirrors the GridTile pattern in /shop. Text floats below outside
          the border so the card reads as a single tappable rectangle, not
          a contained "card box". */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card group-hover:shadow-card-hover group-hover:border-border-mid transition-all duration-300">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.image_url}
          alt={product.title}
          loading="eager"
          className="w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
        />
      </div>
      <div className="pt-3">
        {product.brand && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1 truncate">
            {product.brand}
          </p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">
          {product.title}
        </p>
        {product.price != null && (
          <p className="font-sans text-xs font-medium text-foreground">
            {formatPrice(product.price)}
          </p>
        )}
      </div>
    </button>
  );
}
