/**
 * Side-panel controller.
 *
 * On open:
 *   - Read `pending.imageUrl` from chrome.storage.session. If present, kick
 *     off a twin lookup. If not, show the idle prompt.
 *
 * The image URL is sent straight to the Muse API which does the fetch + embed
 * server-side (cleaner than cross-origin image fetching inside the extension —
 * many CDNs block CORS, many sites block hotlinking, we'd end up writing a
 * proxy anyway). The API already supports `{ imageUrl }` in its request body.
 */

// ── Config ───────────────────────────────────────────────────────────────────
// The deployed Muse domain. Swap for a localhost URL while iterating locally.
const API_BASE = "https://muse.vercel.app";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const screens = {
  idle:     document.getElementById("idle"),
  reading:  document.getElementById("reading"),
  revealed: document.getElementById("revealed"),
  error:    document.getElementById("error"),
};
const yoursImg    = document.getElementById("yours-img");
const twinImg     = document.getElementById("twin-img");
const twinLink    = document.getElementById("twin-link");
const twinBrand   = document.getElementById("twin-brand");
const twinTitle   = document.getElementById("twin-title");
const twinPrice   = document.getElementById("twin-price");
const shopCta     = document.getElementById("shop-cta");
const alternates  = document.getElementById("alternates");
const altWrap     = document.getElementById("alternates-wrap");
const errorMsg    = document.getElementById("error-msg");

// ── State ────────────────────────────────────────────────────────────────────
let candidates   = []; // [twin, ...alternates] flattened
let pickedIndex  = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
}

function formatPrice(p) {
  if (p == null) return "";
  return "$" + Math.round(p).toLocaleString("en-US");
}

function renderTwin(i) {
  const p = candidates[i];
  if (!p) return;
  pickedIndex = i;
  twinImg.src       = p.image_url;
  twinImg.alt       = p.title;
  twinLink.href     = p.product_url;
  twinBrand.textContent = p.brand ?? "";
  twinTitle.textContent = p.title ?? "";
  twinPrice.textContent = formatPrice(p.price);
  shopCta.href      = p.product_url;

  // Highlight selected thumbnail
  [...alternates.querySelectorAll("button")].forEach((b, idx) => {
    b.classList.toggle("selected", idx === i);
  });
}

function renderAlternates() {
  alternates.innerHTML = "";
  if (candidates.length <= 1) {
    altWrap.hidden = true;
    return;
  }
  altWrap.hidden = false;
  candidates.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = i === pickedIndex ? "selected" : "";
    btn.setAttribute("aria-label", `Show twin ${i + 1}: ${p.title}`);
    btn.addEventListener("click", () => renderTwin(i));
    const img = document.createElement("img");
    img.src = p.image_url;
    img.alt = p.title;
    btn.appendChild(img);
    alternates.appendChild(btn);
  });
}

// ── Twin lookup ─────────────────────────────────────────────────────────────
async function findTwin(imageUrl) {
  yoursImg.src = imageUrl;
  show("reading");

  try {
    const res = await fetch(API_BASE + "/api/twin", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ imageUrl }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "request failed" }));
      throw new Error(error ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    candidates = [data.twin, ...(data.alternates ?? [])].filter(Boolean);
    if (candidates.length === 0) throw new Error("no twin found");
    pickedIndex = 0;
    renderAlternates();
    renderTwin(0);
    show("revealed");
  } catch (e) {
    errorMsg.textContent = e?.message || "something went sideways";
    show("error");
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  show("idle");

  const { pending } = await chrome.storage.session.get("pending");
  if (pending?.imageUrl) {
    // Clear so a subsequent manual open doesn't replay the old request.
    await chrome.storage.session.remove("pending");
    findTwin(pending.imageUrl);
  }
}

// Re-run when the panel regains focus with a fresh pending item
// (happens when the user right-clicks another image with the panel already open).
chrome.storage.session.onChanged.addListener((changes) => {
  const next = changes.pending?.newValue;
  if (next?.imageUrl) {
    chrome.storage.session.remove("pending");
    findTwin(next.imageUrl);
  }
});

init();
