const RENDER_SERVER_URL = "https://watchsync-server-vvcc.onrender.com";

const statusEl = document.getElementById("status");
const roomView = document.getElementById("roomView");
const pairView = document.getElementById("pairView");
const roomCodeEl = document.getElementById("roomCode");
const hostWarningEl = document.getElementById("hostWarning");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");

// Wake up Render free-tier container immediately when popup opens
fetch(RENDER_SERVER_URL).catch(() => {});

refresh();

createBtn.addEventListener("click", async () => {
  statusEl.textContent = "Creating room...";
  createBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "create_room" });
    if (res && res.roomCode) {
      refresh(res.roomCode);
    } else {
      statusEl.textContent = res?.error || "Failed to create room";
      statusEl.className = "status error";
    }
  } catch (err) {
    statusEl.textContent = "Error connecting to background script";
    statusEl.className = "status error";
  } finally {
    createBtn.disabled = false;
  }
});

joinBtn.addEventListener("click", async () => {
  const code = document.getElementById("joinInput").value.trim();
  if (!/^\d{6}$/.test(code)) {
    statusEl.textContent = "Enter a valid 6-digit code";
    statusEl.className = "status error";
    return;
  }

  statusEl.textContent = "Connecting to room...";
  joinBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "join_room", roomCode: code });
    if (res && res.ok) {
      refresh(code);
    } else {
      statusEl.textContent = res?.error || "Invalid room code or host is offline.";
      statusEl.className = "status error";
    }
  } catch (err) {
    statusEl.textContent = "Error connecting to signaling server";
    statusEl.className = "status error";
  } finally {
    joinBtn.disabled = false;
  }
});

document.getElementById("leaveBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "leave_room" });
  refresh();
});

document.getElementById("useCurrentTabBtn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "set_stream" });
  flashStreamStatus(res?.ok);
});

document.getElementById("setStreamBtn").addEventListener("click", async () => {
  const url = document.getElementById("streamUrlInput").value.trim();
  if (!url) return;
  const res = await chrome.runtime.sendMessage({ type: "set_stream", url });
  flashStreamStatus(res?.ok);
});

function flashStreamStatus(ok) {
  statusEl.textContent = ok ? "Stream sent to room" : "Couldn't send stream";
  statusEl.className = ok ? "status connected" : "status error";
  setTimeout(refresh, 1500);
}

async function refresh(knownCode) {
  const res = await chrome.runtime.sendMessage({ type: "get_status" });
  const roomCode = knownCode || res?.roomCode;

  if (roomCode) {
    roomView.style.display = "block";
    pairView.style.display = "none";
    roomCodeEl.textContent = roomCode;
  } else {
    roomView.style.display = "none";
    pairView.style.display = "block";
  }

  if (!roomCode) {
    if (!statusEl.className.includes("error")) {
      statusEl.textContent = "Not connected";
      statusEl.className = "status";
    }
    hostWarningEl.style.display = "none";
    return;
  }

  hostWarningEl.style.display = res?.role === "host" ? "block" : "none";

  const roleLabel = res?.role === "host" ? "Hosting" : "Joined";
  if (res?.connected) {
    const peers = res.role === "host" ? ` · ${res.peerCount} connected` : "";
    statusEl.textContent = `${roleLabel} — connected${peers}`;
    statusEl.className = "status connected";
  } else if (res?.signalConnected) {
    statusEl.textContent = `${roleLabel} — waiting for peer...`;
    statusEl.className = "status";
  } else {
    statusEl.textContent = `${roleLabel} — reconnecting...`;
    statusEl.className = "status";
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status") refresh();
});