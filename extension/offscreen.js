// extension/offscreen.js
let signalUrl = "wss://watchsync-server-vvcc.onrender.com";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

let ws = null;
let deviceId = null;
let roomCode = null;
let role = null; // "host" | "peer"

let pcs = new Map();
let channels = new Map();
let pendingCandidates = new Map();
let streamUrl = null;
let lastState = null;

let hostPc = null;
let hostChannel = null;
let peerPendingCandidates = [];

function connectSignaling() {
  return new Promise((resolve, reject) => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch {}
    }

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        teardown();
        reject(new Error("Connection to signaling server timed out."));
      }
    }, 12000);

    ws = new WebSocket(signalUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", room: roomCode, deviceId, role }));
      notifyStatus();
      if (role === "host") {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (!settled) {
        if (msg.type === "join_success") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "no_host") {
          settled = true;
          clearTimeout(timeout);
          teardown();
          reject(new Error("Invalid room code or host is offline."));
          return;
        }
      }

      handleSignal(msg);
    };

    ws.onclose = () => {
      notifyStatus();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Failed to connect to signaling server."));
      } else if (roomCode) {
        setTimeout(connectSignaling, 2000);
      }
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("WebSocket error connecting to server."));
      }
    };
  });
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
    teardown();
    chrome.runtime.sendMessage({ target: "background", type: "clear_session" }).catch(() => {});
    notifyStatus("host_left");
  } else if (msg.type === "no_host" && role === "peer") {
    teardown();
    chrome.runtime.sendMessage({ target: "background", type: "clear_session" }).catch(() => {});
    notifyStatus("no_host");
  }
}

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
  try { msg = JSON.parse(raw); } catch { return; }
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
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === "room_info") {
    if (msg.url) navigateSyncedTab(msg.url, msg.lastState);
  } else if (msg.type === "navigate") {
    navigateSyncedTab(msg.url, msg.state || null);
  } else if (msg.type === "state") {
    applyToTab(msg);
  }
}

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

function teardown() {
  roomCode = null;
  role = null;
  streamUrl = null;
  lastState = null;
  teardownConnections();
  if (ws) {
    try { ws.close(); } catch {}
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "local_state") {
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
    if (message.serverUrl) signalUrl = message.serverUrl;

    connectSignaling()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
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