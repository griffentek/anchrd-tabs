const NTP = 'chrome://newtab/';
const NO_GROUP = -1;

const DEFAULTS = {
  positioning: { linkClick: 'right', blankNewTab: 'right', reopened: 'right' },
  focus:       { linkClick: 'foreground', blankNewTab: 'foreground' },
  onClose:     { activate: 'last-used' },
  moveToOpenerGroup: true,
  preventDuplicates: false,
  enabled: true,
};

let cfg = structuredClone(DEFAULTS);

// --- Debug instrumentation -------------------------------------------------
// Flip to false before publishing. Logs to the service-worker console AND
// persists to chrome.storage.local so they survive the worker restarting
// (needed to capture the cold-start path, which only happens with DevTools
// CLOSED — an open inspector keeps the worker alive and hides the bug).
//
// To read captured logs after an idle/cold-start test:
//   1. chrome://extensions -> Anchrd Tabs -> click "service worker"
//   2. In that console run:  dumpLogs()
//   3. To reset between runs:  clearLogs()
const DEBUG = false;
const PERSIST_LOGS = false;
// Unique per worker instance so keys from different lifetimes never collide
// and sort chronologically. (Plain extension runtime — Date.now() is fine here.)
const INSTANCE = Date.now().toString(36);
let evtSeq = 0;
function dlog(label, data) {
  if (!DEBUG) return;
  const seq = ++evtSeq;
  console.log(`[anchrd ${INSTANCE}#${seq}] ${label}`, data ?? '');
  if (PERSIST_LOGS) {
    const key = `anchrd_log:${INSTANCE}:${String(seq).padStart(5, '0')}`;
    chrome.storage.local.set({ [key]: { t: Date.now(), label, data: data ?? null } }).catch(() => {});
  }
}

// Console helpers (callable from the service-worker console)
globalThis.dumpLogs = async () => {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith('anchrd_log:'))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  console.log(`[anchrd] ${entries.length} stored log entries (oldest first):`);
  for (const [, v] of entries) console.log(new Date(v.t).toLocaleTimeString(), v.label, v.data ?? '');
  return entries.map(([, v]) => v);
};
globalThis.clearLogs = async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('anchrd_log:'));
  await chrome.storage.local.remove(keys);
  console.log(`[anchrd] cleared ${keys.length} log entries`);
};

async function loadCfg() {
  const raw = await chrome.storage.sync.get(null);
  cfg = {
    ...DEFAULTS, ...raw,
    positioning: { ...DEFAULTS.positioning, ...(raw.positioning ?? {}) },
    focus:       { ...DEFAULTS.focus,       ...(raw.focus       ?? {}) },
    onClose:     { ...DEFAULTS.onClose,     ...(raw.onClose     ?? {}) },
  };
}

// On restart, activeTab and lastUsed are empty for already-open windows.
// Seed them from existing tabs so onRemoved works without requiring navigation first.
async function initWindowState() {
  const tabs = await chrome.tabs.query({});
  const byWindow = {};
  for (const tab of tabs) {
    (byWindow[tab.windowId] ??= []).push(tab);
    tabIdx[tab.id] = tab.index;
  }
  for (const [wid, wTabs] of Object.entries(byWindow)) {
    const winId = Number(wid);
    const active = wTabs.find(t => t.active);
    if (!active) continue;
    activeTab[winId] ??= active.id;
    // Seed history: active tab first, then others by real recency — Chrome tracks
    // when each tab was last active (tab.lastAccessed, Chrome 121+). Fall back to
    // descending index (rightmost = most recently opened) where it's missing.
    // Merge under anything an event handler has already recorded for this window.
    const others = wTabs.filter(t => !t.active)
      .sort((a, b) => ((b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)) || (b.index - a.index));
    const seed = [active.id, ...others.map(t => t.id)];
    const live = lastUsed[winId] ?? [];
    lastUsed[winId] = [...live, ...seed.filter(id => !live.includes(id))].slice(0, 20);
  }
}

// Per-window state. Mirrored to chrome.storage.session so it survives the MV3
// service worker being terminated (Chrome idles it out after ~30s). Without this,
// closing the active tab WAKES the worker from cold with empty maps, so onRemoved
// can't tell the closed tab was active and silently leaves Chrome's own (often
// rightmost) choice in place — the intermittent close-activation bug.
const lastUsed   = {};   // windowId -> tabId[] most-recent-first, capped at 20
const activeTab  = {};   // windowId -> tabId currently active
const openerOf   = {};   // tabId -> openerTabId
const tabIdx     = {};   // tabId -> last known index (updated on create + move)
const linkUrl    = {};   // tabId -> URL the tab was opened to load; lets preventDuplicates
                         // match tabs whose URL changed after open (redirects, SPA rewrites)

const lastAct    = {};   // windowId -> { tabId, prevActive, at } most recent onActivated;
                         // used to detect Chrome's auto-activation racing ahead of onRemoved
const settled    = new Set(); // tabIds that completed their first load (in-memory only)
const selfClosed = new Set(); // tabIds the extension removed itself (dedup) — their
                              // onRemoved must not run close-activation logic
const pendingLink = new Map(); // tabId -> createdAt, for opener-created tabs with no URL yet
                               // (target=_blank / window.open: the URL arrives at first commit)

let restoredAt = 0;      // timestamp of last chrome.sessions.onChanged

const STATE_KEY = '__anchrd_state';

// Written on every state change. session storage is in-memory and survives worker
// restarts within a browser session, so it always holds the latest snapshot.
// No-op until hydration has merged the previous snapshot in — a handler running
// on a freshly woken worker must not overwrite the full snapshot with the one or
// two entries it has written so far.
let hydrated = false;
function persistState() {
  if (!hydrated) return;
  chrome.storage.session.set({ [STATE_KEY]: { lastUsed, activeTab, openerOf, tabIdx, linkUrl } }).catch(() => {});
}

async function readPersistedState() {
  try { return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? {}; }
  catch { return {}; }
}

// The pre-close snapshot, captured by the FIRST session read at worker startup.
// Nothing runs while the worker sleeps, so this read returns state exactly as it
// was before the close that woke us; being the first storage op queued, a later
// onActivated write cannot clobber it before onRemoved reads it.
let bootState = {};

async function hydrateState() {
  bootState = await readPersistedState();
  const hasState = Object.keys(bootState.activeTab ?? {}).length > 0;
  if (hasState) {
    // Warm restart within the browser session — merge the snapshot UNDER anything
    // the waking event's handler has already written. (An all-or-nothing guard here
    // would drop the whole MRU history whenever a tab switch woke the worker: that
    // onActivated runs before this read resolves and leaves a one-entry stack.)
    for (const [w, stack] of Object.entries(bootState.lastUsed ?? {})) {
      const live = lastUsed[w] ?? [];
      lastUsed[w] = [...live, ...stack.filter(id => !live.includes(id))].slice(0, 20);
    }
    for (const [w, id] of Object.entries(bootState.activeTab ?? {})) if (!(w in activeTab)) activeTab[w] = id;
    for (const [k, v] of Object.entries(bootState.openerOf ?? {}))   if (!(k in openerOf))  openerOf[k]  = v;
    for (const [k, v] of Object.entries(bootState.tabIdx ?? {}))     if (!(k in tabIdx))    tabIdx[k]    = v;
    for (const [k, v] of Object.entries(bootState.linkUrl ?? {}))    if (!(k in linkUrl))   linkUrl[k]   = v;
  } else {
    // Genuine fresh start (new browser session) — seed from the current tab list.
    await initWindowState();
    bootState = { lastUsed, activeTab, openerOf, tabIdx, linkUrl };
  }
  hydrated = true;
  persistState();
}

// Stored as promises so handlers can await readiness on a cold start.
let cfgReady   = loadCfg();
let stateReady = hydrateState();
// Only reload config when the settings (storage.sync) change — not when the debug
// logger (storage.local) or the state mirror (storage.session) writes.
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') cfgReady = loadCfg(); });

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  dlog('onActivated', { tabId, windowId, prevActive: activeTab[windowId], stackBefore: [...(lastUsed[windowId] ?? [])] });
  lastAct[windowId] = {
    tabId, prevActive: activeTab[windowId], at: Date.now(),
    // Pre-activation stack snapshot: if this activation turns out to be Chrome's
    // auto-replacement racing ahead of onRemoved, this is the state to restore.
    stackBefore: [...(lastUsed[windowId] ?? [])],
  };
  activeTab[windowId] = tabId;
  lastUsed[windowId] = [tabId, ...(lastUsed[windowId] ?? []).filter(id => id !== tabId)].slice(0, 20);
  persistState();
});

chrome.tabs.onMoved.addListener((tabId, { toIndex }) => {
  tabIdx[tabId] = toIndex;
  persistState();
});

chrome.sessions.onChanged.addListener(() => {
  restoredAt = Date.now();
});

function classify(tab) {
  const url = tab.pendingUrl ?? tab.url ?? '';
  // Link clicks always navigate to http/https/file URLs.
  // Cmd+T goes to chrome://newtab/, a custom-NTP chrome-extension://, or empty —
  // so checking for a real web URL is more robust than matching specific NTP strings.
  const isWebURL = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
  if (tab.openerTabId != null && isWebURL) return 'linkClick';
  if (Date.now() - restoredAt < 150) return 'reopened';
  return 'blankNewTab';
}

// Comparison form for dedup: drop the fragment and any trailing slash so
// cosmetic differences don't defeat the match.
function normUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    const s = x.href;
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch { return u; }
}

// If a tab matching `url` is already open in the same window, switch to it and
// close `tab`. Matches each candidate's current URL, in-flight URL, and the URL
// it was originally opened to load (so server redirects and SPA URL rewrites
// don't hide the duplicate). Returns true if the new tab was collapsed.
async function collapseDuplicate(tab, url) {
  const target = normUrl(url);
  if (!target || url === NTP) return false;
  const all = await chrome.tabs.query({ windowId: tab.windowId });
  const dupe = all.find(t => t.id !== tab.id &&
    (normUrl(t.url) === target || normUrl(t.pendingUrl) === target || normUrl(linkUrl[t.id]) === target));
  if (!dupe) return false;
  selfClosed.add(tab.id); // this activate+remove pair would otherwise look exactly
                          // like Chrome's auto-activation race to onRemoved
  await chrome.tabs.update(dupe.id, { active: true });
  await chrome.tabs.remove(tab.id);
  return true;
}

async function safeMove(tabId, index) {
  try {
    await chrome.tabs.move(tabId, { index });
  } catch (e) {
    if (String(e?.message).includes('drag')) {
      await new Promise(r => setTimeout(r, 80));
      try { await chrome.tabs.move(tabId, { index }); } catch {}
    }
  }
}

async function computeTargetIndex(tab, pos, refId) {
  if (pos === 'end') return -1;

  if (pos === 'beginning') {
    const all = await chrome.tabs.query({ windowId: tab.windowId });
    return all.filter(t => t.pinned).length;
  }

  // Resolve reference tab (opener for link clicks, active tab for blank new tabs)
  let refIdx = tab.index;
  try {
    if (refId != null) {
      refIdx = (await chrome.tabs.get(refId)).index;
    } else {
      const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (active && active.id !== tab.id) refIdx = active.index;
    }
  } catch {}

  // Adjustment needed because moving a tab shifts others:
  // If new tab is left of ref, removing it shifts ref one step left.
  if (pos === 'right') return tab.index < refIdx ? refIdx : refIdx + 1;
  if (pos === 'left')  return tab.index < refIdx ? refIdx - 1 : refIdx;
  return -1;
}

chrome.tabs.onCreated.addListener(async (tab) => {
  tabIdx[tab.id] = tab.index;
  if (tab.openerTabId != null) openerOf[tab.id] = tab.openerTabId;
  // Capture the previously active tab now, before Chrome fires onActivated for the new tab
  let prevActiveId = activeTab[tab.windowId];
  persistState();

  await Promise.all([cfgReady, stateReady]);
  if (!cfg.enabled) return;

  // On a cold wake the pre-await read was empty; the hydrated maps know better.
  if (prevActiveId == null) {
    const merged = activeTab[tab.windowId];
    prevActiveId = merged !== tab.id ? merged
      : (lastUsed[tab.windowId] ?? []).find(id => id !== tab.id);
  }

  const trigger = classify(tab);
  dlog('onCreated', { tabId: tab.id, windowId: tab.windowId, opener: tab.openerTabId, index: tab.index, trigger, prevActiveId, url: tab.pendingUrl ?? tab.url });

  if (trigger === 'linkClick') {
    const url = tab.pendingUrl ?? tab.url;
    linkUrl[tab.id] = url;
    persistState();
    // Deduplicate: if an identical URL is already open, switch to it and close the new tab
    if (cfg.preventDuplicates && (await collapseDuplicate(tab, url))) return;
  } else if (tab.openerTabId != null && tab.pendingUrl == null && (!tab.url || tab.url === 'about:blank')) {
    // target=_blank / window.open: the tab is created blank and its URL only
    // arrives at the first navigation commit — handled in onUpdated below.
    pendingLink.set(tab.id, Date.now());
  }

  // Positioning — for linkClick use opener; for blankNewTab, openerTabId is the tab
  // that was active when Cmd+T was pressed, so use it as the reference too.
  const pos = cfg.positioning[trigger] ?? 'default';
  if (pos !== 'default') {
    const refId = tab.openerTabId ?? prevActiveId ?? null;
    const idx = await computeTargetIndex(tab, pos, refId);
    await safeMove(tab.id, idx);
  }

  // Focus
  const focusRule = cfg.focus[trigger];
  if (focusRule === 'background') {
    const prev = (lastUsed[tab.windowId] ?? []).find(id => id !== tab.id);
    if (prev) try { await chrome.tabs.update(prev, { active: true }); } catch {}
  } else if (focusRule === 'foreground') {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch {}
  }

  // Move new tab into opener's group if it has one
  if (cfg.moveToOpenerGroup && tab.openerTabId != null) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      if (opener.groupId !== NO_GROUP) {
        await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tab.id] });
      }
    } catch {}
  }
});

// First-commit handling for tabs created blank (target=_blank / window.open),
// plus origin-URL upkeep for the dedup matcher.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) {
    const created = pendingLink.get(tabId);
    if (created != null) {
      pendingLink.delete(tabId);
      // Only trust commits arriving soon after creation — a slow first commit is
      // more likely a user-initiated navigation in a blank tab than the link load.
      if (Date.now() - created < 10_000 && /^(https?|file):/.test(info.url)) {
        linkUrl[tabId] = info.url;
        persistState();
        await Promise.all([cfgReady, stateReady]);
        if (cfg.enabled && cfg.preventDuplicates) {
          dlog('onUpdated first-commit dedup check', { tabId, url: info.url });
          await collapseDuplicate(tab, info.url);
        }
      }
    } else if (settled.has(tabId) && linkUrl[tabId] && normUrl(info.url) !== normUrl(linkUrl[tabId])) {
      // The tab navigated somewhere new after its first load finished — its
      // origin URL no longer describes what it shows.
      delete linkUrl[tabId];
      persistState();
    }
  }
  if (info.status === 'complete') settled.add(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  // Captured before any await: the race check below compares this against the
  // last activation's timestamp. Cold-start storage reads can take hundreds of
  // milliseconds — measuring after them would make a genuine auto-activation
  // race look stale.
  const arrivedAt = Date.now();

  // A close the extension performed itself (dedup collapse): clean up state but
  // run no close-activation logic — the focus switch to the surviving duplicate
  // has already been made deliberately.
  if (selfClosed.delete(tabId)) {
    await stateReady;
    delete openerOf[tabId];
    delete tabIdx[tabId];
    delete linkUrl[tabId];
    settled.delete(tabId);
    pendingLink.delete(tabId);
    if (lastUsed[windowId]) lastUsed[windowId] = lastUsed[windowId].filter(id => id !== tabId);
    persistState();
    dlog('onRemoved -> self-closed (dedup), no redirect', { tabId, windowId });
    return;
  }

  // Make sure settings are loaded and the persisted snapshot has been merged into
  // the live maps before reading them — on a close that wakes a cold worker, this
  // resolves with the pre-close state (the first storage read is queued before any
  // handler write can clobber it).
  await Promise.all([cfgReady, stateReady]);

  let stack        = lastUsed[windowId] ?? [];
  let active       = activeTab[windowId];
  const savedIdx    = tabIdx[tabId];
  const savedOpener = openerOf[tabId];

  // Event-order race: on some machines Chrome dispatches onActivated for its
  // auto-chosen replacement BEFORE onRemoved (warm or as a cold-wake pair). That
  // makes the closed tab look inactive and leaves Chrome's pick (the right-hand
  // neighbour) in place. Detect the pattern — the current active tab was activated
  // milliseconds ago, displacing the tab now being closed — and undo it.
  const la = lastAct[windowId];
  const autoRace = active !== tabId && la != null && active === la.tabId && stack[0] === la.tabId
    && (la.prevActive === tabId || (la.prevActive == null && bootState.activeTab?.[windowId] === tabId))
    && arrivedAt - la.at < 250;
  if (autoRace) {
    // Restore the stack as it was BEFORE the auto-activation — Chrome's pick keeps
    // its legitimate MRU position (it is often the true last-used tab, e.g. the
    // opener; simply deleting it would bounce the redirect to the wrong tab).
    // On a cold wake the activation ran pre-hydration with an empty stack, so the
    // pre-race state is the boot snapshot.
    stack = la.stackBefore.includes(tabId) ? la.stackBefore : (bootState.lastUsed?.[windowId] ?? []);
    active = tabId;
  }

  const closedPos = stack.indexOf(tabId);

  // Tab was active if it was tracked as active, OR it's still at the front of the
  // history stack (Chrome's onActivated hasn't fired yet for the replacement).
  const wasActive = active === tabId || closedPos === 0;

  // "Last used" = the tab that was active just before this one: the entries after
  // it in the history stack, best first. If the closed tab isn't in the stack at
  // all (degraded state) but we still know it was active, every known entry is a
  // better guess than the by-index fallback (the right-hand neighbour). Snapshot
  // the cleaned stack now for the redirect below.
  const cleanStack = stack.filter(id => id !== tabId);
  const luCandidates = closedPos >= 0 ? stack.slice(closedPos + 1) : cleanStack;

  dlog('onRemoved', {
    tabId, windowId, isWindowClosing, autoRace,
    active, stack: [...stack], closedPos, wasActive,
    luCandidates, savedIdx, savedOpener,
    rule: cfg.onClose.activate, enabled: cfg.enabled,
  });

  // Drop the closed tab from the live maps and persist the cleaned snapshot.
  delete openerOf[tabId];
  delete tabIdx[tabId];
  delete linkUrl[tabId];
  settled.delete(tabId);
  pendingLink.delete(tabId);
  if (lastUsed[windowId]) lastUsed[windowId] = lastUsed[windowId].filter(id => id !== tabId);
  persistState();

  if (isWindowClosing || !cfg.enabled || cfg.onClose.activate === 'default' || !wasActive) {
    dlog('onRemoved -> NO redirect', { isWindowClosing, enabled: cfg.enabled, rule: cfg.onClose.activate, wasActive });
    return;
  }

  setTimeout(async () => {
    const remaining = await chrome.tabs.query({ windowId });
    if (remaining.length === 0) return;

    const rule = cfg.onClose.activate;
    let target;

    if (rule === 'last-used') {
      // Walk the history stack for the first candidate still open — entries can be
      // dead if their tabs closed in quick succession.
      for (const id of luCandidates) {
        target = remaining.find(t => t.id === id);
        if (target) break;
      }
      if (target) {
        // Restore the clean stack before activating — Chrome's intermediate auto-activation
        // will have inserted an extra tab at position 1, which would corrupt the next close.
        lastUsed[windowId] = cleanStack;
        persistState();
      }
    } else if (rule === 'opener' && savedOpener != null) {
      target = remaining.find(t => t.id === savedOpener);
    } else if (rule === 'left' && savedIdx != null) {
      target = remaining.find(t => t.index === savedIdx - 1);
    } else if (rule === 'right' && savedIdx != null) {
      target = remaining.find(t => t.index === savedIdx);
    }

    const primaryId = target?.id;
    if (!target) {
      if (savedIdx == null) { dlog('redirect -> ABORT (no savedIdx, Chrome default stands)'); return; }
      const sorted = [...remaining].sort((a, b) => a.index - b.index);
      target = sorted[Math.min(savedIdx, sorted.length - 1)];
      dlog('redirect -> FALLBACK by index', {
        savedIdx, fallbackTargetId: target?.id,
        remaining: remaining.map(t => ({ id: t.id, index: t.index, active: t.active })),
      });
    }

    dlog('redirect -> activate', { rule, luCandidates, primaryId, finalTargetId: target?.id, activeNow: activeTab[windowId] });
    if (target) {
      try { await chrome.tabs.update(target.id, { active: true }); } catch {}
    }
  }, 0);
});
