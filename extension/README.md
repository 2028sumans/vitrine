# Muse — Find its Twin (Chrome extension)

Right-click any image anywhere on the web, get its small-batch twin from the
Muse Back Catalogue.

## Install locally (unpacked)

1. In Chrome, go to `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. The Muse icon appears in the toolbar.

## How to use

- Right-click any product image on the web (Zara, Instagram, Pinterest, Shein…) → **Find its Twin**.
- The side panel opens with *Yours* on the left and *Its Twin* on the right,
  plus a rail of alternate twins below.
- Click the twin to open the product page in a new tab.

## Architecture

```
manifest.json       MV3, contextMenus + sidePanel
background.js       Service worker — registers the context-menu item,
                    stashes the clicked image URL, opens the side panel
sidepanel.html/css  UI shell
sidepanel.js        Reads stashed URL → POSTs /api/twin → renders result
icons/              Generated via sharp from an inline SVG (see build note)
```

The API call is `POST https://muse.vercel.app/api/twin` with body
`{ "imageUrl": "https://…" }`. The Muse server fetches the image,
FashionCLIP-embeds it, kNN-searches Pinecone, hydrates the top hits via
Algolia, and returns `{ twin, alternates }`.

## Local dev against localhost

Edit `sidepanel.js`:

```js
const API_BASE = "http://localhost:3000";
```

Reload the extension (chrome://extensions → reload icon) and test against
a running `npm run dev`.

## Submitting to the Chrome Web Store

1. Zip the contents of this directory (not the directory itself).
2. Go to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).
3. Pay the one-time $5 developer fee, create a new item, upload the zip.
4. Fill in the store listing:
   - **Name**: Muse — Find its Twin
   - **Short description** (132 chars):
     *"Right-click any image. Get its Back Catalogue twin from an independent label."*
   - **Category**: Shopping
   - **Screenshots**: at least one 1280×800 hero shot of the side panel in action
   - **Privacy policy URL**: required — explain that image URLs are sent to
     `muse.vercel.app/api/twin` and not stored
5. First review typically 2–7 days. Updates after approval are instant.

## Regenerating icons

```bash
node --input-type=module -e "
import sharp from 'sharp';
for (const size of [16, 48, 128]) {
  const svg = \`<svg xmlns='http://www.w3.org/2000/svg' width='\${size}' height='\${size}'>
    <rect width='100%' height='100%' fill='#EDE5D0'/>
    <text x='50%' y='50%' text-anchor='middle' dominant-baseline='central'
          font-family='Georgia, serif' font-size='\${Math.round(size * 0.75)}' fill='#333E1D'>M</text>
  </svg>\`;
  await sharp(Buffer.from(svg)).png().toFile('extension/icons/icon-' + size + '.png');
}
"
```

## TODO

- [ ] Instagram / TikTok DOM hooks so a hover-button appears on posts
- [ ] Account sync so the sidepanel's "save" button lands in the Muse shortlist
- [ ] Safari / Firefox ports (same MV3, different store submission)
- [ ] Rate limiting on `/api/twin` once usage warrants it
