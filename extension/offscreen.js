// offscreen.js
// Lives inside the extension's offscreen document because
// RTCPeerConnection isn't available in a service worker. Offscreen
// documents can ONLY use chrome.runtime (messaging) — no chrome.storage,
// no chrome.tabs, nothing else. So every storage/tab operation below is
// actually a message to background.js, which performs it and (for the ones
// that need an answer) replies via sendResponse.
//
//   - The device that creates a room is the "host". It keeps one
//     RTCPeerConnection + data channel open per joined peer, and acts as
//     the hub: any state/set_stream message it receives from one peer gets
//     relayed to every other peer over their own data channels, and
//     applied to the host's own tab. The host also holds the only copy of
//     "what's playing" (streamUrl / lastState) — nothing is persisted on
//     the signaling server.
//   - A "peer" holds exactly one RTCPeerConnection, to the host. It sends
//     its local state to the host and applies whatever the host sends back.
//
// The signaling server (signaling-server/server.js) only ever sees the SDP
// offer/answer/ICE-candidate exchange needed to establish these
// connections — no playback data passes through it.

const SIGNAL_URL = "ws://localhost:8080"; // <-- set to your deployed signaling server
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
  // Optional TURN fallback for networks where direct P2P can't establish
  // (symmetric NATs, some corporate/mobile networks). Without one, those
  // pairings simply won't connect. Add your own if you hit this:
  // { urls: "turn:your-turn-server:3478", username: "...", credential: "..." }
];

let ws = null;
let deviceId = null;
let roomCode = null;
let role = null; // "host" | "peer"

// Host-only state
let pcs = new Map(); // peerId -> RTCPeerConnection
let channels = new Map(); // peerId -> RTCDataChannel
let pendingCandidates = new Map(); // peerId -> queued ICE candidates
let streamUrl = null;
let lastState = null;

// Peer-only state
let hostPc = null;
let hostChannel = null;
let peerPendingCandidates = [];

// background.js tells us when to start (fresh create/join, or restoring
// after a browser restart) via a "begin" message — we don't read storage
// ourselves, since we can't.

// ---- Signaling ----

function connectSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(SIGNAL_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", room: roomCode, deviceId, role }));
    notifyStatus();
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleSignal(msg);
  };
  ws.onclose = () => {
    notifyStatus();
    if (roomCode) setTimeout(connectSignaling, 2000);
  };
  ws.onerror = () => {};
}

function sendSignal(to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "signal", room: roomCode, to, from: deviceId, data }));
  }
}

function handleSignal(msg) {
  if (msg.type === "peer_wants_join" && role === "host") {
    createHostConnection(msg.from);
  } else if (msg.type === "signal") {
    if (role === "host") handleHostSignal(msg.from, msg.data);
    else handlePeerSignal(msg.data);
  } else if (msg.type === "peer_disconnected" && role === "host") {
    const pc = pcs.get(msg.from);
    if (pc) pc.close();
    pcs.delete(msg.from);
    channels.delete(msg.from);
    pendingCandidates.delete(msg.from);
    notifyStatus();
  } else if (msg.type === "host_left" && role === "peer") {
    teardownConnections();
    notifyStatus("host_left");
  } else if (msg.type === "no_host" && role === "peer") {
    notifyStatus("no_host");
  }
}

// ---- Host: one RTCPeerConnection per joined peer ----

function createHostConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pcs.set(peerId, pc);
  pendingCandidates.set(peerId, []);

  const channel = pc.createDataChannel("sync");
  setupHostChannel(peerId, channel);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      pcs.delete(peerId);
      channels.delete(peerId);
      notifyStatus();
    }
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => sendSignal(peerId, { sdp: pc.localDescription }));
}

function handleHostSignal(peerId, data) {
  const pc = pcs.get(peerId);
  if (!pc) return;
  if (data.sdp) {
    pc.setRemoteDescription(data.sdp).then(() => flushCandidates(peerId, pc));
  } else if (data.candidate) {
    if (pc.remoteDescription && pc.remoteDescription.type) {
      pc.addIceCandidate(data.candidate).catch(() => {});
    } else {
      pendingCandidates.get(peerId)?.push(data.candidate);
    }
  }
}

function flushCandidates(peerId, pc) {
  const queue = pendingCandidates.get(peerId) || [];
  for (const c of queue) pc.addIceCandidate(c).catch(() => {});
  pendingCandidates.set(peerId, []);
}

function setupHostChannel(peerId, channel) {
  channels.set(peerId, channel);
  channel.onopen = () => {
    notifyStatus();
    // Catch the new peer up on what the room's already doing. lastState may
    // itself be a "heartbeat" (drift-only, not a play/pause instruction) —
    // normalize it to an actual play command for this purpose, since a
    // fresh joiner's video is paused by default and needs to be told to
    // actually start.
    channel.send(JSON.stringify({ type: "room_info", url: streamUrl, lastState: toCatchupState(lastState) }));
  };
  channel.onmessage = (e) => handleHostChannelMessage(peerId, e.data);
  channel.onclose = () => {
    channels.delete(peerId);
    notifyStatus();
  };
}

function toCatchupState(state) {
  if (!state) return null;
  return state.action === "heartbeat" ? { ...state, action: "play" } : state;
}

function handleHostChannelMessage(peerId, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "state") {
    lastState = msg;
    relayToOtherPeers(peerId, raw);
    applyToTab(msg);
  } else if (msg.type === "set_stream") {
    streamUrl = msg.url;
    lastState = msg.state || null;
    relayToOtherPeers(peerId, JSON.stringify({ type: "navigate", url: msg.url, state: lastState }));
    navigateSyncedTab(msg.url, lastState);
  }
}

function relayToOtherPeers(excludePeerId, raw) {
  for (const [pid, ch] of channels) {
    if (pid !== excludePeerId && ch.readyState === "open") ch.send(raw);
  }
}

// ---- Peer: single RTCPeerConnection, to the host ----

function handlePeerSignal(data) {
  if (data.sdp && data.sdp.type === "offer") {
    hostPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    hostPc.ondatachannel = (e) => setupPeerChannel(e.channel);
    hostPc.onicecandidate = (e) => {
      if (e.candidate) sendSignal("host", { candidate: e.candidate });
    };
    hostPc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(hostPc.connectionState)) {
        notifyStatus();
      }
    };

    hostPc
      .setRemoteDescription(data.sdp)
      .then(() => {
        for (const c of peerPendingCandidates) hostPc.addIceCandidate(c).catch(() => {});
        peerPendingCandidates = [];
      })
      .then(() => hostPc.createAnswer())
      .then((answer) => hostPc.setLocalDescription(answer))
      .then(() => sendSignal("host", { sdp: hostPc.localDescription }));
  } else if (data.candidate) {
    if (hostPc && hostPc.remoteDescription && hostPc.remoteDescription.type) {
      hostPc.addIceCandidate(data.candidate).catch(() => {});
    } else {
      peerPendingCandidates.push(data.candidate);
    }
  }
}

function setupPeerChannel(channel) {
  hostChannel = channel;
  channel.onopen = () => notifyStatus();
  channel.onmessage = (e) => handlePeerChannelMessage(e.data);
  channel.onclose = () => {
    hostChannel = null;
    notifyStatus();
  };
}

function handlePeerChannelMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "room_info") {
    if (msg.url) navigateSyncedTab(msg.url, msg.lastState);
  } else if (msg.type === "navigate") {
    navigateSyncedTab(msg.url, msg.state || null);
  } else if (msg.type === "state") {
    applyToTab(msg);
  }
}

// ---- Tab control: proxied through background.js, which is the only
// context here with actual chrome.tabs access. ----

function applyToTab(state) {
  chrome.runtime.sendMessage({ target: "background", type: "tabs_apply_state", payload: state }).catch(() => {});
}

function navigateSyncedTab(url, pendingState) {
  chrome.runtime.sendMessage({ target: "background", type: "tabs_navigate", url, pendingState }).catch(() => {});
}

async function getActiveTabUrlAndState() {
  try {
    const res = await chrome.runtime.sendMessage({ target: "background", type: "tabs_get_active_url_and_state" });
    return res || { url: null, state: null };
  } catch {
    return { url: null, state: null };
  }
}

function toStateMessage(captured) {
  return {
    type: "state",
    deviceId,
    action: captured.paused ? "pause" : "play",
    time: captured.time,
    rate: captured.rate,
    ts: Date.now()
  };
}

// ---- Lifecycle ----

function teardown() {
  roomCode = null;
  role = null;
  streamUrl = null;
  lastState = null;
  teardownConnections();
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
}

function teardownConnections() {
  for (const pc of pcs.values()) pc.close();
  pcs.clear();
  channels.clear();
  pendingCandidates.clear();
  if (hostPc) {
    hostPc.close();
    hostPc = null;
  }
  hostChannel = null;
}

function notifyStatus(reason) {
  chrome.runtime.sendMessage({ type: "status", reason }).catch(() => {});
}

// ---- Messages from content scripts (direct) and background (routed from popup) ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "local_state") {
    // Just message metadata (sender.tab), not a chrome.tabs API call — this
    // works fine in an offscreen document, unlike actually calling
    // chrome.tabs.* directly.
    const payload = JSON.stringify({
      type: "state",
      deviceId,
      action: message.action,
      time: message.time,
      rate: message.rate,
      ts: Date.now()
    });
    if (role === "host") {
      lastState = JSON.parse(payload);
      for (const ch of channels.values()) if (ch.readyState === "open") ch.send(payload);
    } else if (role === "peer" && hostChannel && hostChannel.readyState === "open") {
      hostChannel.send(payload);
    }
    return;
  }

  if (message.target !== "offscreen") return;

  if (message.type === "begin") {
    roomCode = message.roomCode;
    role = message.role;
    deviceId = message.deviceId;
    connectSignaling();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "stop") {
    teardown();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "set_stream") {
    (async () => {
      let url = message.url;
      let capturedState = null;

      if (!url) {
        // "Sync Room to This Tab" — no URL given means use the current tab,
        // and critically, also grab its exact playback position so everyone
        // else starts (or jumps to) the same spot instead of 0:00.
        const res = await getActiveTabUrlAndState();
        url = res.url;
        capturedState = res.state;
      }
      if (!url) {
        sendResponse({ ok: false });
        return;
      }

      streamUrl = url;
      lastState = capturedState ? toStateMessage(capturedState) : null;

      if (role === "host") {
        const navRaw = JSON.stringify({ type: "navigate", url, state: lastState });
        for (const ch of channels.values()) if (ch.readyState === "open") ch.send(navRaw);
        navigateSyncedTab(url, lastState);
      } else if (role === "peer" && hostChannel && hostChannel.readyState === "open") {
        hostChannel.send(JSON.stringify({ type: "set_stream", url, state: lastState }));
        navigateSyncedTab(url, lastState);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "get_status") {
    sendResponse({
      roomCode,
      role,
      signalConnected: !!(ws && ws.readyState === WebSocket.OPEN),
      connected: role === "host" ? channels.size > 0 : !!(hostChannel && hostChannel.readyState === "open"),
      peerCount: role === "host" ? channels.size : undefined
    });
    return;
  }
});
