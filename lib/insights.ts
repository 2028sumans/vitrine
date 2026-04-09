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

export function getUserToken(): string {
  if (typeof window === "undefined") return "anon";
  const key = "muse_user_token";
  let token = localStorage.getItem(key);
  if (!token) {
    token = "anon-" + crypto.randomUUID();
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
