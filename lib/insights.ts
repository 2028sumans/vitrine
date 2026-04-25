"use client";

// ── Algolia Insights — client-side event tracking ────────────────────────────
// Sends click + view events to Algolia so Personalization and Dynamic Re-Ranking
// have real signal data to learn from. Uses the Algolia Insights REST API
// directly — no extra package needed.

const ALGOLIA_APP_ID  = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID!;
const ALGOLIA_SEARCH_KEY = process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY!;
const INDEX_NAME      = "vitrine_products";
const INSIGHTS_URL    = `https://insights.algolia.io/1/events`;

// ── User token ────────────────────────────────────────────────────────────────
// Anonymous UUID per browser, persisted in localStorage.
// Swap this for your real user ID once auth is in place.

/**
 * UUID v4 generator that works on every browser we care about.
 *
 *   Tier 1: native crypto.randomUUID()     — Chrome 92+, Firefox 95+, Safari 15.4+
 *   Tier 2: crypto.getRandomValues + bit-fiddle  — iOS 6+, all modern browsers
 *   Tier 3: Math.random (non-crypto, fine for an anonymous analytics id)
 *
 * The native form gets called first when present. Older iPads stuck below
 * iOS 15.4 would otherwise throw TypeError on crypto.randomUUID() and take
 * down the entire page via the uncaught exception.
 */
function uuidv4(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }
  // Last-resort fallback — not cryptographically random, but adequate for
  // an anonymous analytics token on a device too old to have getRandomValues.
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-4${r().slice(1)}-${((Math.random() * 4) | 8).toString(16)}${r().slice(1)}-${r()}${r()}${r()}`;
}

export function getUserToken(): string {
  if (typeof window === "undefined") return "anon";
  const key = "muse_user_token";
  let token = localStorage.getItem(key);
  if (!token) {
    token = "anon-" + uuidv4();
    localStorage.setItem(key, token);
  }
  return token;
}

// ── Event sending ─────────────────────────────────────────────────────────────

async function sendEvent(event: Record<string, unknown>): Promise<void> {
  if (!ALGOLIA_APP_ID || !ALGOLIA_SEARCH_KEY) return;
  try {
    await fetch(INSIGHTS_URL, {
      method: "POST",
      headers: {
        "Content-Type":        "application/json",
        "X-Algolia-Application-Id": ALGOLIA_APP_ID,
        "X-Algolia-API-Key":        ALGOLIA_SEARCH_KEY,
      },
      body: JSON.stringify({ events: [event] }),
    });
  } catch {
    // Non-fatal — never break the UI over analytics
  }
}

// ── Public event helpers ──────────────────────────────────────────────────────

/**
 * Fire when a user clicks through to a product.
 * Requires queryID (returned by Algolia when clickAnalytics: true).
 */
export function trackProductClick({
  userToken,
  objectID,
  queryID,
  position,
}: {
  userToken: string;
  objectID:  string;
  queryID:   string;
  position:  number;  // 1-indexed position in the displayed list
}): void {
  if (!queryID) {
    // Fallback: no queryID — send a plain click event (still useful for re-ranking)
    sendEvent({
      eventType:  "click",
      eventName:  "Product Clicked",
      index:      INDEX_NAME,
      userToken,
      objectIDs:  [objectID],
    });
    return;
  }
  sendEvent({
    eventType:  "click",
    eventName:  "Product Clicked",
    index:      INDEX_NAME,
    userToken,
    queryID,
    objectIDs:  [objectID],
    positions:  [position],
  });
}

/**
 * Fire when a curated edit is displayed.
 * Builds the personalization profile even without clicks.
 */
export function trackProductsViewed({
  userToken,
  objectIDs,
}: {
  userToken: string;
  objectIDs: string[];
}): void {
  if (!objectIDs.length) return;
  // Algolia Insights accepts max 20 objectIDs per event
  const chunks: string[][] = [];
  for (let i = 0; i < objectIDs.length; i += 20) {
    chunks.push(objectIDs.slice(i, i + 20));
  }
  for (const chunk of chunks) {
    sendEvent({
      eventType: "view",
      eventName: "Products Viewed",
      index:     INDEX_NAME,
      userToken,
      objectIDs: chunk,
    });
  }
}

/**
 * Fire on a strong, deliberate signal — save to shortlist, heart-tap,
 * external "Shop" click-out, etc. Conversions weight ~10× higher than
 * view events in Algolia's personalization profile build, so distinguishing
 * them from passive clicks matters a lot.
 *
 * `queryID` is the optional provenance id Algolia returns when
 * `clickAnalytics: true` on the search. Including it lets Algolia attribute
 * the conversion to the exact ranked list it served, which is what
 * "conversion-after-search" personalization strategies key off. Without
 * it, the event still feeds the profile but counts as a generic conversion
 * (no per-position attribution).
 */
export function trackProductConversion({
  userToken,
  objectID,
  queryID,
  eventName = "Product Saved",
}: {
  userToken:  string;
  objectID:   string;
  queryID?:   string;
  eventName?: string;
}): void {
  const event: Record<string, unknown> = {
    eventType: "conversion",
    eventName,
    index:     INDEX_NAME,
    userToken,
    objectIDs: [objectID],
  };
  if (queryID) event.queryID = queryID;
  sendEvent(event);
}
