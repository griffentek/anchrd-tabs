# Anchrd Tabs

A lightweight browser extension that gives you control over where new tabs open, what gets focus, and which tab activates when you close one. Available for Chrome and Firefox.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/anchrd-tabs-open-next-to/gleafkjllnfkbndfiecnpcpaifigfnck)

---

## Features

- **Tab positioning** - Open new tabs to the right of the current tab, to the left, at the start, or at the end. Configured independently for link clicks, Ctrl+T, and Ctrl+Shift+T.
- **Focus control** - Choose whether a new tab steals focus or opens in the background, per trigger type.
- **After-close activation** - When you close a tab, choose what activates next: left neighbour, right neighbour, the opener tab, your last-used tab, or Chrome's default.
- **Join opener's group** - Tabs opened from a grouped tab automatically join that group.
- **Prevent duplicates** - If the URL is already open, switch to the existing tab instead of opening another.

## Why

Chrome's default behaviour sends every new tab to the far end of the tab strip. If you open several links from an article, you have to hunt across the bar to find them. Anchrd Tabs keeps new tabs anchored to whatever you were working on.

The after-close behaviour is the other one most people don't know they want - Chrome's default is unpredictable. Setting it to "last used" means closing a tab always returns you to where you were.

## Firefox

Anchrd Tabs also works on Firefox (115+; tab-group support needs 138+).
Install from [addons.mozilla.org](https://addons.mozilla.org/) - link TBC after first AMO review.

## Code

Manifest V3, no build step, no dependencies.

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (Chrome) |
| `manifest.firefox.json` | MV3 manifest (Firefox - event page, gecko settings) |
| `background.js` | Background worker - all tab logic, shared by both browsers |
| `options.html` | Settings panel |
| `options.js` | Reads/writes `chrome.storage.sync` |

Permissions used: `tabs`, `storage`, `sessions`.

## Privacy

No data is collected, stored remotely, or transmitted. All settings are saved locally via `chrome.storage.sync` (synced to your own Google account). The extension does not read page content.
