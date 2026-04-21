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

// Store the promise so onCreated can await it on service worker restart
let cfgReady = Promise.all([loadCfg(), initWindowState()]);
chrome.storage.onChanged.addListener(() => { cfgReady = loadCfg(); });

// Per-window state — lost on service worker restart, degrades gracefully
const lastUsed   = {};   // windowId -> tabId[] most-recent-first, capped at 20
const activeTab  = {};   // windowId -> tabId currently active
const openerOf   = {};   // tabId -> openerTabId
const tabIdx     = {};   // tabId -> last known index (updated on create + move)

let restoredAt = 0;      // timestamp of last chrome.sessions.onChanged

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTab[windowId] = tabId;
  lastUsed[windowId] = [tabId, ...(lastUsed[windowId] ?? []).filter(id => id !== tabId)].slice(0, 20);
});

chrome.tabs.onMoved.addListener((tabId, { toIndex }) => {
  tabIdx[tabId] = toIndex;
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

  await cfgReady;
  if (!cfg.enabled) return;

  const trigger = classify(tab);

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

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  // Capture state synchronously — Chrome may fire onActivated for its auto-chosen tab
  // before or after this handler, which would modify lastUsed and activeTab.
  const stack = lastUsed[windowId] ?? [];
  const closedPos = stack.indexOf(tabId);

  // Tab was active if: it's currently tracked as active, OR it's still at the front of
  // the history stack (meaning Chrome's onActivated hasn't fired yet for the replacement).
  const wasActive = activeTab[windowId] === tabId || closedPos === 0;

  // "Last used" = the tab that was active just before this one. Find tabId in the
  // history stack and take the next entry — captured now before Chrome can modify the stack.
  const lastUsedTargetId = closedPos >= 0 ? stack[closedPos + 1] : undefined;
  // Snapshot the correct stack now — Chrome's auto-activation fires between here and
  // the setTimeout and would corrupt lastUsed, making the next close pick the wrong tab.
  const cleanStack = stack.filter(id => id !== tabId);

  const savedIdx    = tabIdx[tabId];
  const savedOpener = openerOf[tabId];

  delete openerOf[tabId];
  delete tabIdx[tabId];
  if (lastUsed[windowId]) lastUsed[windowId] = lastUsed[windowId].filter(id => id !== tabId);

  if (isWindowClosing || !cfg.enabled || cfg.onClose.activate === 'default' || !wasActive) return;

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
      }
    } else if (rule === 'opener' && savedOpener != null) {
      target = remaining.find(t => t.id === savedOpener);
    } else if (rule === 'left' && savedIdx != null) {
      target = remaining.find(t => t.index === savedIdx - 1);
    } else if (rule === 'right' && savedIdx != null) {
      target = remaining.find(t => t.index === savedIdx);
    }

    if (!target) {
      if (savedIdx == null) return; // no position info — let Chrome's default stand
      const sorted = [...remaining].sort((a, b) => a.index - b.index);
      target = sorted[Math.min(savedIdx, sorted.length - 1)];
    }

    if (target) {
      try { await chrome.tabs.update(target.id, { active: true }); } catch {}
    }
  }, 0);
});
