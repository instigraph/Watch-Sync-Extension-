const statusEl = document.getElementById("status");
const roomView = document.getElementById("roomView");
const pairView = document.getElementById("pairView");
const roomCodeEl = document.getElementById("roomCode");
const hostWarningEl = document.getElementById("hostWarning");

refresh();

document.getElementById("createBtn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "create_room" });
  refresh(res.roomCode);
});

document.getElementById("joinBtn").addEventListener("click", async () => {
  const code = document.getElementById("joinInput").value.trim();
  if (!/^\d{6}$/.test(code)) {
    statusEl.textContent = "Enter a valid 6-digit code";
    return;
  }
  await chrome.runtime.sendMessage({ type: "join_room", roomCode: code });
  refresh(code);
});

document.getElementById("leaveBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "leave_room" });
  refresh();
});

document.getElementById("useCurrentTabBtn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "set_stream" }); // no url = use active tab
  flashStreamStatus(res.ok);
});

document.getElementById("setStreamBtn").addEventListener("click", async () => {
  const url = document.getElementById("streamUrlInput").value.trim();
  if (!url) return;
  const res = await chrome.runtime.sendMessage({ type: "set_stream", url });
  flashStreamStatus(res.ok);
});

function flashStreamStatus(ok) {
  statusEl.textContent = ok ? "Stream sent to room" : "Couldn't send stream";
  setTimeout(refresh, 1500);
}

async function refresh(knownCode) {
  const res = await chrome.runtime.sendMessage({ type: "get_status" });
  const roomCode = knownCode || res.roomCode;
  if (roomCode) {
    roomView.style.display = "block";
    pairView.style.display = "none";
    roomCodeEl.textContent = roomCode;
  } else {
    roomView.style.display = "none";
    pairView.style.display = "block";
  }

  if (!roomCode) {
    statusEl.textContent = "Not connected";
    statusEl.className = "status";
    hostWarningEl.style.display = "none";
    return;
  }

  hostWarningEl.style.display = res.role === "host" ? "block" : "none";

  const roleLabel = res.role === "host" ? "Hosting" : "Joined";
  if (res.connected) {
    const peers = res.role === "host" ? ` · ${res.peerCount} connected` : "";
    statusEl.textContent = `${roleLabel} — connected${peers}`;
    statusEl.className = "status connected";
  } else if (res.signalConnected) {
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
