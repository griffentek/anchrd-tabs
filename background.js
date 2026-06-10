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
    activeTab[winId] = active.id;
    // Seed history: active tab first, then others in descending index order
    // (rightmost = most recently opened is a reasonable heuristic).
    const others = wTabs.filter(t => !t.active).sort((a, b) => b.index - a.index);
    lastUsed[winId] = [active.id, ...others.map(t => t.id)];
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

let restoredAt = 0;      // timestamp of last chrome.sessions.onChanged

const STATE_KEY = '__anchrd_state';

// Written on every state change. session storage is in-memory and survives worker
// restarts within a browser session, so it always holds the latest snapshot.
function persistState() {
  chrome.storage.session.set({ [STATE_KEY]: { lastUsed, activeTab, openerOf, tabIdx } }).catch(() => {});
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
    // Warm restart within the browser session — restore the live maps. Per-map
    // guards avoid clobbering anything a concurrent event has already written.
    if (Object.keys(lastUsed).length === 0)  Object.assign(lastUsed,  bootState.lastUsed  ?? {});
    if (Object.keys(activeTab).length === 0) Object.assign(activeTab, bootState.activeTab ?? {});
    if (Object.keys(openerOf).length === 0)  Object.assign(openerOf,  bootState.openerOf  ?? {});
    if (Object.keys(tabIdx).length === 0)    Object.assign(tabIdx,    bootState.tabIdx    ?? {});
  } else {
    // Genuine fresh start (new browser session) — seed from the current tab list.
    await initWindowState();
    bootState = { lastUsed, activeTab, openerOf, tabIdx };
  }
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
  const prevActiveId = activeTab[tab.windowId];
  persistState();

  await Promise.all([cfgReady, stateReady]);
  if (!cfg.enabled) return;

  const trigger = classify(tab);
  dlog('onCreated', { tabId: tab.id, windowId: tab.windowId, opener: tab.openerTabId, index: tab.index, trigger, prevActiveId });

  // Deduplicate: if an identical URL is already open, switch to it and close the new tab
  if (cfg.preventDuplicates && trigger === 'linkClick') {
    const url = tab.pendingUrl ?? tab.url;
    if (url && url !== NTP) {
      const all = await chrome.tabs.query({ windowId: tab.windowId });
      const dupe = all.find(t => t.id !== tab.id && (t.url === url || t.pendingUrl === url));
      if (dupe) {
        await chrome.tabs.update(dupe.id, { active: true });
        await chrome.tabs.remove(tab.id);
        return;
      }
    }
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

chrome.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  // Warm path: read the live in-memory maps synchronously, before Chrome's
  // onActivated for its auto-chosen replacement can mutate them.
  let stack       = lastUsed[windowId] ?? [];
  let active      = activeTab[windowId];
  let savedIdx    = tabIdx[tabId];
  let savedOpener = openerOf[tabId];

  // Cold start: the worker was terminated while idle and woken by THIS close, so the
  // live maps are empty. Recover the pre-close snapshot captured at startup from
  // storage.session (untouched while the worker slept). This is the fix for the
  // intermittent "jumps to the rightmost tab" bug.
  const coldStart = stack.length === 0 && active == null;
  if (coldStart) {
    await stateReady;
    stack       = bootState.lastUsed?.[windowId] ?? [];
    active      = bootState.activeTab?.[windowId];
    savedIdx    = bootState.tabIdx?.[tabId];
    savedOpener = bootState.openerOf?.[tabId];
  }

  const closedPos = stack.indexOf(tabId);

  // Tab was active if it was tracked as active, OR it's still at the front of the
  // history stack (Chrome's onActivated hasn't fired yet for the replacement).
  const wasActive = active === tabId || closedPos === 0;

  // "Last used" = the tab that was active just before this one: the next entry in
  // the history stack. Snapshot the cleaned stack now for the redirect below.
  const lastUsedTargetId = closedPos >= 0 ? stack[closedPos + 1] : undefined;
  const cleanStack = stack.filter(id => id !== tabId);

  dlog('onRemoved', {
    tabId, windowId, isWindowClosing, coldStart,
    active, stack: [...stack], closedPos, wasActive,
    lastUsedTargetId, savedIdx, savedOpener,
    rule: cfg.onClose.activate, enabled: cfg.enabled,
  });

  // Drop the closed tab from the live maps and persist the cleaned snapshot.
  delete openerOf[tabId];
  delete tabIdx[tabId];
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
      target = remaining.find(t => t.id === lastUsedTargetId);
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

    dlog('redirect -> activate', { rule, lastUsedTargetId, primaryId, finalTargetId: target?.id, activeNow: activeTab[windowId] });
    if (target) {
      try { await chrome.tabs.update(target.id, { active: true }); } catch {}
    }
  }, 0);
});
