// background.js
// Offscreen documents can ONLY use chrome.runtime (for messaging) — not
// chrome.storage, not chrome.tabs, not anything else. (This is a hard
// Chrome platform restriction, not a permissions issue — see
// https://developer.chrome.com/docs/extensions/reference/api/offscreen :
// "The runtime API is the only extensions API supported by offscreen
// documents.") So this file owns ALL storage and tab access, and acts as
// a proxy: offscreen.js sends it request messages (target: "background")
// whenever it needs to read/write storage or touch a tab, and this file
// does the actual chrome.storage.*/chrome.tabs.* call on its behalf.

const OFFSCREEN_PATH = "offscreen.html";
const PAIRING_MESSAGE_TYPES = new Set([
  "create_room",
  "join_room",
  "leave_room",
  "set_stream",
  "get_status"
]);

let syncedTabId = null; // the tab we treat as "the" synced player

restoreIfNeeded();
chrome.runtime.onStartup.addListener(restoreIfNeeded);

async function restoreIfNeeded() {
  const stored = await chrome.storage.local.get(["roomCode", "role"]);
  if (!stored.roomCode || !stored.role) return;
  const deviceId = await getOrCreateDeviceId();
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "begin",
    roomCode: stored.roomCode,
    role: stored.role,
    deviceId
  });
}

async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(["deviceId"]);
  if (stored.deviceId) return stored.deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function hasOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return existing.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WEB_RTC"],
    justification: "Maintain peer-to-peer WebRTC connections for cross-device playback sync."
  });
}

// ---- Tab control (the actual implementation; offscreen.js only ever asks
// for this via message, since it has no chrome.tabs access itself) ----

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function applyToSyncedTab(state) {
  const tab = syncedTabId ? { id: syncedTabId } : await getActiveTab();
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "remote_state", payload: state }).catch(() => {});
}

async function navigateSyncedTab(url, pendingState) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  syncedTabId = tab.id;

  if (tab.url === url) {
    // This tab is already showing that content — it's presumably the
    // source of the state we'd otherwise be "catching it up" to, so
    // there's nothing to apply here.
    return;
  }

  const listener = (tabId, changeInfo) => {
    if (tabId === tab.id && changeInfo.status === "complete") {
      chrome.tabs.onUpdated.removeListener(listener);
      if (pendingState) applyOnceReady(tabId, pendingState);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  chrome.tabs.update(tab.id, { url }).catch(() => chrome.tabs.onUpdated.removeListener(listener));
}

function applyOnceReady(tabId, state) {
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: "remote_state", payload: state }).catch(() => {});
  }, 1500);
}

// ---- Message routing ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From content.js: just track which tab is "the" synced player. The
  // actual relay of this event happens in offscreen.js, which also
  // receives this same broadcast directly (message passing works fine
  // there — it's storage/tabs specifically that don't).
  if (message.type === "local_state") {
    if (sender.tab) syncedTabId = sender.tab.id;
    return;
  }

  // From offscreen.js: proxied storage/tabs requests it can't make itself.
  if (message.target === "background") {
    if (message.type === "tabs_get_active_url") {
      (async () => {
        const tab = await getActiveTab();
        sendResponse({ url: tab?.url });
      })();
      return true;
    }
    if (message.type === "tabs_get_active_url_and_state") {
      (async () => {
        const tab = await getActiveTab();
        if (!tab || !tab.id) {
          sendResponse({ url: null, state: null });
          return;
        }
        let state = null;
        try {
          state = await chrome.tabs.sendMessage(tab.id, { type: "get_current_state" });
        } catch {
          // content script not present/ready on this tab — proceed without state
        }
        sendResponse({ url: tab.url, state: state || null });
      })();
      return true;
    }
    if (message.type === "tabs_navigate") {
      (async () => {
        await navigateSyncedTab(message.url, message.pendingState);
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (message.type === "tabs_apply_state") {
      (async () => {
        await applyToSyncedTab(message.payload);
        sendResponse({ ok: true });
      })();
      return true;
    }
    return;
  }

  // From popup.js
  if (PAIRING_MESSAGE_TYPES.has(message.type)) {
    (async () => {
      if (message.type === "create_room") {
        const deviceId = await getOrCreateDeviceId();
        const roomCode = generateRoomCode();
        await chrome.storage.local.set({ roomCode, role: "host" });
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ target: "offscreen", type: "begin", roomCode, role: "host", deviceId });
        sendResponse({ roomCode });
        return;
      }

      if (message.type === "join_room") {
        const deviceId = await getOrCreateDeviceId();
        const roomCode = message.roomCode;
        await chrome.storage.local.set({ roomCode, role: "peer" });
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ target: "offscreen", type: "begin", roomCode, role: "peer", deviceId });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "leave_room") {
        await chrome.storage.local.remove(["roomCode", "role"]);
        if (await hasOffscreenDocument()) {
          await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
        }
        sendResponse({ ok: true });
        return;
      }

      // set_stream / get_status: no point spinning up an offscreen document
      // just to answer these if one doesn't already exist (no active room).
      if (!(await hasOffscreenDocument())) {
        sendResponse(
          message.type === "get_status"
            ? { roomCode: null, role: null, connected: false, signalConnected: false }
            : { ok: false }
        );
        return;
      }
      const res = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
      sendResponse(res);
    })();
    return true; // keep the message channel open for the async response
  }
});

// Global keyboard shortcuts (see manifest.json "commands"). These act
// directly on whatever tab is currently focused — no relay/offscreen
// involvement needed, since the resulting native video event flows through
// the normal local_state reporting path in content.js -> offscreen.js.
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  const actionMap = {
    "toggle-play-pause": "toggle",
    "seek-forward-10": "seek_forward",
    "seek-back-10": "seek_back"
  };
  const action = actionMap[command];
  if (!action) return;

  chrome.tabs.sendMessage(tab.id, { type: "trigger_control", action }).catch(() => {});
});
