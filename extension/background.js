// extension/background.js
const OFFSCREEN_PATH = "offscreen.html";
const SIGNAL_SERVER_URL = "wss://watchsync-server-vvcc.onrender.com";

const PAIRING_MESSAGE_TYPES = new Set([
  "create_room",
  "join_room",
  "leave_room",
  "set_stream",
  "get_status"
]);

let syncedTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === syncedTabId) syncedTabId = null;
});

restoreIfNeeded();
chrome.runtime.onStartup.addListener(restoreIfNeeded);

async function restoreIfNeeded() {
  const stored = await chrome.storage.local.get(["roomCode", "role"]);
  if (!stored.roomCode || !stored.role) return;
  const deviceId = await getOrCreateDeviceId();
  await ensureOffscreenDocument();
  await sendToOffscreenWithRetry({
    target: "offscreen",
    type: "begin",
    roomCode: stored.roomCode,
    role: stored.role,
    deviceId,
    serverUrl: SIGNAL_SERVER_URL
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

async function sendToOffscreenWithRetry(message, retries = 5, delay = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab;
  const [lastFocused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (lastFocused) return lastFocused;
  const [anyActive] = await chrome.tabs.query({ active: true });
  return anyActive || null;
}

async function applyToSyncedTab(state) {
  const tab = syncedTabId ? { id: syncedTabId } : await getActiveTab();
  if (!tab || !tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "remote_state", payload: state }).catch(() => {
    getActiveTab().then((activeTab) => {
      if (activeTab && activeTab.id) {
        syncedTabId = activeTab.id;
        chrome.tabs.sendMessage(activeTab.id, { type: "remote_state", payload: state }).catch(() => {});
      }
    });
  });
}

async function navigateSyncedTab(url, pendingState) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  syncedTabId = tab.id;

  if (tab.url === url) {
    if (pendingState) applyToSyncedTab(pendingState);
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
  let retries = 0;
  const interval = setInterval(() => {
    chrome.tabs.sendMessage(tabId, { type: "remote_state", payload: state })
      .then(() => clearInterval(interval))
      .catch(() => {
        retries++;
        if (retries >= 8) clearInterval(interval);
      });
  }, 350);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Fix 1: Forward local_state from content.js directly to offscreen document
  if (message.type === "local_state") {
    if (sender.tab) syncedTabId = sender.tab.id;
    (async () => {
      if (await hasOffscreenDocument()) {
        sendToOffscreenWithRetry({
          target: "offscreen",
          type: "local_state",
          payload: message,
          ...message
        }).catch(() => {});
      }
    })();
    return;
  }

  if (message.type === "tabs_trigger_control") {
    (async () => {
      const tab = syncedTabId ? { id: syncedTabId } : await getActiveTab();
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "trigger_control", action: message.action }).catch(() => {});
      }
    })();
    return;
  }

  if (message.target === "background") {
    if (message.type === "clear_session") {
      chrome.storage.local.remove(["roomCode", "role"]);
      return;
    }
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
        syncedTabId = tab.id;
        let state = null;
        try {
          state = await chrome.tabs.sendMessage(tab.id, { type: "get_current_state" });
        } catch {}
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

  if (PAIRING_MESSAGE_TYPES.has(message.type)) {
    (async () => {
      if (message.type === "create_room") {
        const deviceId = await getOrCreateDeviceId();
        const roomCode = generateRoomCode();
        await ensureOffscreenDocument();

        const res = await sendToOffscreenWithRetry({
          target: "offscreen",
          type: "begin",
          roomCode,
          role: "host",
          deviceId,
          serverUrl: SIGNAL_SERVER_URL
        });

        if (res && res.ok) {
          await chrome.storage.local.set({ roomCode, role: "host" });
          sendResponse({ roomCode });
        } else {
          sendResponse({ error: res?.error || "Failed to create room" });
        }
        return;
      }

      if (message.type === "join_room") {
        const deviceId = await getOrCreateDeviceId();
        const roomCode = message.roomCode;
        await ensureOffscreenDocument();

        const res = await sendToOffscreenWithRetry({
          target: "offscreen",
          type: "begin",
          roomCode,
          role: "peer",
          deviceId,
          serverUrl: SIGNAL_SERVER_URL
        });

        if (res && res.ok) {
          await chrome.storage.local.set({ roomCode, role: "peer" });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: res?.error || "Invalid room code or host is offline." });
        }
        return;
      }

      if (message.type === "leave_room") {
        await chrome.storage.local.remove(["roomCode", "role"]);
        if (await hasOffscreenDocument()) {
          await sendToOffscreenWithRetry({ target: "offscreen", type: "stop" });
        }
        sendResponse({ ok: true });
        return;
      }

      if (!(await hasOffscreenDocument())) {
        sendResponse(
          message.type === "get_status"
            ? { roomCode: null, role: null, connected: false, signalConnected: false }
            : { ok: false }
        );
        return;
      }
      const res = await sendToOffscreenWithRetry({ ...message, target: "offscreen" });
      sendResponse(res);
    })();
    return true;
  }
});

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