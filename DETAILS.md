# ClipX Extension — Overview & Features

**Name:** ClipX - Track & Trade on X  
**Tagline:** Your co-pilot and profile intelligence layer for X (Twitter).  
**Manifest:** Chrome Extension Manifest V3  
**Current version:** `1.22.0` (see [`manifest.json`](manifest.json))

This document summarizes what the extension does and which capabilities ship in this tree. For step-by-step QA, see [`TESTING_GUIDE.md`](TESTING_GUIDE.md).

---

## What it does

ClipX runs mainly on **x.com** / **twitter.com** and enriches the timeline and profiles with trading-oriented tooling, social-intel signals, and cross-post helpers. It talks to **clipx.app** for auth and backend APIs, and optionally integrates embedded tools (charts, maps, DEX data) inside the extension UI.

---

## Core features

### Authentication & account

- Sign-in flows in the popup / side panel: **key-based login** and **web login** (session sync).
- **[`src/auth-sync.js`](src/auth-sync.js)** runs on **clipx.app** / **www.clipx.app** to keep extension storage aligned with the web app.

### On X — timeline & tweets

- **Tip controls** — Per-tweet tip affordances (toggleable via settings); integrates with the ClipX backend wallet flow.
- **Token awareness in tweet text** — Resolves tickers (e.g. via CoinGecko), injects **token pills** and related inline actions where applicable.
- **Intel / analyze** — Extra control in the tweet action bar to open analysis flows for the tweet URL.
- **Cross-post to Binance Square** — A dedicated action on tweets opens Binance Square and assists with **composer auto-fill**, **multi-image** handling, optional **manual retry**, and **history** (e.g. “already posted” indicator on the action). Implemented with clipx.app API usage (see comments in [`src/content.js`](src/content.js)).

### Profile & social intelligence

- **Profile scanner & labels** — Badges/labels on profiles, lists (followers/following-style views), “Who to follow” / sidebar rows, and feed items (including quoted authors), driven by ClipX/KOL-style data.
- **Sorsa (TweetScout-style) scores** — Visual score treatment on avatars (timeline, compose surfaces, profile hero areas).
- **Surf 7d sentiment** — Batched social-intel detail from `/api/social-intel/detail` (7-day window), cached in the service worker for performance.

### Home & optional widgets

- **Market insight widget** — Optional home-timeline widget (toggleable); can be disabled from settings.

### Trading & research embeds

- In-page and extension UI can host iframes for tools such as **Bubblemaps**, **GMGN**, **InsightX**, **Faster100x**, and **Dexscreener** (see CSP `frame-src` in [`manifest.json`](manifest.json)).
- **[`rules.json`](rules.json)** uses **Declarative Net Request** to relax `X-Frame-Options` / `Content-Security-Policy` on **subframes** for selected third-party hosts so those embeds can load inside the extension context.

### GMGN / wallet bridge

- **[`src/wallet_content.js`](src/wallet_content.js)** (and related inject scripts) run on **gmgn.ai** / **gmgn.cc** (including frames) to bridge wallet/session behavior with the extension.

### Background service worker

- **[`src/background.js`](src/background.js)** handles messaging, API calls to clipx.app (including sentiment caching), **ethers.js**-based contract interaction (e.g. Four.meme–related addresses documented in code), storage-backed configuration, and coordination with popup/content scripts.

### Chrome UI surfaces

- **Browser action** popup: [`src/popup.html`](src/popup.html) / [`src/popup.js`](src/popup.js).
- **Side panel** default path: same popup HTML (see `side_panel` in [`manifest.json`](manifest.json)).
- **Options:** [`src/options.html`](src/options.html) — extended wallet/settings UI.

---

## User-facing settings (high-level)

Stored in `chrome.storage.local` and applied live where supported:

- Show or hide **tip buttons**.
- **Market insight** widget on home.
- **Label visual style** (e.g. gradient vs other presets).
- **Surf / social sentiment** visibility (content script refresh via messaging).

---

## Permissions & hosts (summary)

| Capability | Purpose |
|------------|---------|
| `storage` | Auth tokens, preferences, caches |
| `declarativeNetRequest` | Header tweaks for embeddable iframes ([`rules.json`](rules.json)) |
| `sidePanel` | Side panel entry using the ClipX UI |

**Host permissions** (from manifest): X/Twitter, clipx.app, GMGN, GoPlus, Dexscreener, CoinGecko, Bubblemaps, Twitter syndication — each tied to specific features (APIs, embeds, media).

---

## Project layout (main entrypoints)

| Path | Role |
|------|------|
| [`manifest.json`](manifest.json) | Extension definition, permissions, content script matches |
| [`src/background.js`](src/background.js) | Service worker / backend of the extension |
| [`src/content.js`](src/content.js) | Primary X.com injection and UI hooks |
| [`src/popup.html`](src/popup.html) / [`src/popup.js`](src/popup.js) | Toolbar popup & side panel UI |
| [`src/options.html`](src/options.html) / [`src/options.js`](src/options.js) | Full options page |
| [`src/auth-sync.js`](src/auth-sync.js) | Web app auth sync |
| [`rules.json`](rules.json) | DNR rules for iframe embedding |
| [`TESTING_GUIDE.md`](TESTING_GUIDE.md) | Manual test plans and pass criteria |

---

## Install (development / unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** and select this folder: `analysis/ClipX Extension` (the directory that contains `manifest.json`).

---

## Version notes

- Product **version** is defined in [`manifest.json`](manifest.json) (`version` field).
- [`TESTING_GUIDE.md`](TESTING_GUIDE.md) may reference an older version label in its header; treat the manifest as the source of truth for the shipped build in this repo snapshot.

---

## License / distribution

Add your repository’s license file at the repo root if you publish on GitHub; this folder does not define a license by itself.
