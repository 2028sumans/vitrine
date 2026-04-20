/**
 * Persist the /shop scroll-feed signals (likes, click history, fast-swipe
 * dislikes, dwell times) across browser sessions.
 *
 * Why: without this, every return visit starts cold — the recommender has no
 * idea what the user responded to last time. localStorage persistence means a
 * returning user's first fetch already knows "they like Staud, they dislike
 * anything with 'blazer' in the title" and seeds the feed accordingly.
 *
 * Scope: one slot, client-wide (no per-category separation — their taste
 * should transfer). Written behind a versioned key so we can evolve the
 * shape without corrupting existing clients.
 */
import type { ClickSignalLike } from "./scoring";

const KEY = "muse:session-signals:v1";

/** Caps — keep storage small, bounded, and the most recent. */
const MAX_LIKES           = 80;   // likedIds set
const MAX_CLICK_HISTORY   = 60;   // ranking weighting caps at 30; persist a buffer
const MAX_DISLIKE_SIGNALS = 60;   // same rationale
const MAX_DWELL_ENTRIES   = 200;  // LRU-ish trim in saveSessionSignals

export interface PersistedSignals {
  likedIds:        string[];
  clickHistory:    ClickSignalLike[];
  dislikedSignals: ClickSignalLike[];
  dwellTimes:      Record<string, number>;
  /** Epoch ms when last saved — useful for future decay / staleness logic. */
  savedAt:         number;
}

/** Safe read. Returns null if nothing saved, parse fails, or we're SSR. */
export function loadSessionSignals(): PersistedSignals | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSignals;
    // Light defensive shape-check — anything malformed → treat as empty.
    if (!parsed || typeof parsed !== "object") return null;
    return {
      likedIds:        Array.isArray(parsed.likedIds)        ? parsed.likedIds        : [],
      clickHistory:    Array.isArray(parsed.clickHistory)    ? parsed.clickHistory    : [],
      dislikedSignals: Array.isArray(parsed.dislikedSignals) ? parsed.dislikedSignals : [],
      dwellTimes:      typeof parsed.dwellTimes === "object" && parsed.dwellTimes !== null
                         ? parsed.dwellTimes
                         : {},
      savedAt:         typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Debounced write. Called on every signal change; coalesces rapid updates
 *  so we don't hit localStorage on every scroll frame. */
let pendingTimer: number | null = null;
let pendingPayload: PersistedSignals | null = null;

function trimDwell(dwellTimes: Record<string, number>): Record<string, number> {
  const keys = Object.keys(dwellTimes);
  if (keys.length <= MAX_DWELL_ENTRIES) return dwellTimes;
  // Trim oldest by insertion order. JS object key order is insertion-order
  // for string keys, which is what we want — the most recently recorded
  // dwells are at the end. Drop from the front.
  const drop = keys.length - MAX_DWELL_ENTRIES;
  const out: Record<string, number> = {};
  let i = 0;
  for (const k of keys) {
    if (i++ < drop) continue;
    out[k] = dwellTimes[k];
  }
  return out;
}

export function saveSessionSignals(state: {
  likedIds:        Set<string> | string[];
  clickHistory:    ClickSignalLike[];
  dislikedSignals: ClickSignalLike[];
  dwellTimes:      Record<string, number>;
}): void {
  if (typeof window === "undefined") return;
  const payload: PersistedSignals = {
    likedIds:        (state.likedIds instanceof Set
                        ? Array.from(state.likedIds)
                        : state.likedIds).slice(-MAX_LIKES),
    clickHistory:    state.clickHistory.slice(0, MAX_CLICK_HISTORY),
    dislikedSignals: state.dislikedSignals.slice(0, MAX_DISLIKE_SIGNALS),
    dwellTimes:      trimDwell(state.dwellTimes),
    savedAt:         Date.now(),
  };
  pendingPayload = payload;
  if (pendingTimer != null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    const toWrite = pendingPayload;
    pendingPayload = null;
    if (!toWrite) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(toWrite));
    } catch {
      // Quota exceeded or privacy mode — silently fail. We'll retry on next
      // signal. Persistence is best-effort; the feed still works without it.
    }
  }, 500);
}

/** Flush any pending write immediately. Call from visibilitychange /
 *  beforeunload so the tab close doesn't drop the last few signals. */
export function flushSessionSignals(): void {
  if (typeof window === "undefined" || pendingPayload == null) return;
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pendingPayload));
  } catch { /* ignore */ }
  pendingPayload = null;
}

/** Clear all persisted signals. Used by "reset my feed" affordances. */
export function clearSessionSignals(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
  pendingPayload = null;
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}
