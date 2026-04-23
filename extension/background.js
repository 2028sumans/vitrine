/**
 * Service worker — wires the right-click "Find its Twin" context menu
 * to the side-panel that does the actual image → twin lookup.
 *
 * Flow:
 *   1. Install hook registers the context menu item on image elements.
 *   2. User right-clicks an image → we stash the srcUrl in chrome.storage.session.
 *   3. Open the side panel for the tab (or focus it if already open).
 *   4. sidepanel.js reads the stashed URL, calls /api/twin, renders results.
 *
 * The service worker is the only place we can call `chrome.sidePanel.open()`
 * with the user gesture from a contextMenu click, which is why the flow
 * goes through here instead of directly into the panel.
 */

const MENU_ID = "muse-find-its-twin";

// ── Install: register the context menu item ──────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:        MENU_ID,
    title:     "Find its Twin",
    contexts:  ["image"],
  });

  // Allow the action button (toolbar icon) to open the side panel too,
  // so users can trigger a manual upload flow from there in the future.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Right-click "Find its Twin" ──────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return;

  // Stash the image URL where the side panel will find it. `session` storage
  // is per-browser-session and never persists to disk — good hygiene for
  // image URLs that may be private (e.g. Instagram saves).
  await chrome.storage.session.set({
    pending: {
      imageUrl: info.srcUrl,
      sourceUrl: info.pageUrl ?? null,
      requestedAt: Date.now(),
    },
  });

  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    // Fallback: some Chrome versions require windowId instead of tabId.
    try {
      if (tab.windowId != null) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    } catch (err2) {
      console.error("[muse] failed to open side panel:", err, err2);
    }
  }
});
