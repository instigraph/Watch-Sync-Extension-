// extension/content.js
// Handles HTML5 <video> state extraction and synchronization on web pages.

let isRemoteChange = false;
let remoteLockTimer = null;

function findBestVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;

  return videos.reduce((best, v) => {
    const area = v.offsetWidth * v.offsetHeight;
    const bestArea = best ? best.offsetWidth * best.offsetHeight : 0;
    if (!v.paused) return v;
    return area > bestArea ? v : best;
  }, null);
}

function lockRemoteEvents(durationMs = 1000) {
  isRemoteChange = true;
  if (remoteLockTimer) clearTimeout(remoteLockTimer);
  remoteLockTimer = setTimeout(() => {
    isRemoteChange = false;
  }, durationMs);
}

function attachVideoListeners(video) {
  if (!video || video.dataset.watchsyncAttached) return;
  video.dataset.watchsyncAttached = "true";

  const events = ["play", "pause", "seeked", "ratechange"];
  events.forEach((evt) => {
    video.addEventListener(evt, () => {
      if (isRemoteChange) {
        lockRemoteEvents(600); // Extend lock while handling synthetic remote events
        return;
      }
      sendLocalState(video, evt);
    });
  });
}

function sendLocalState(video, eventType) {
  if (!video) return;

  chrome.runtime.sendMessage({
    type: "local_state",
    action: video.paused ? "pause" : "play",
    time: video.currentTime,
    rate: video.playbackRate,
    event: eventType,
    ts: Date.now()
  }).catch(() => {});
}

function applyRemoteState(payload) {
  const video = findBestVideo();
  if (!video) return;

  attachVideoListeners(video);
  lockRemoteEvents(1200);

  const targetTime = payload.time;
  if (typeof targetTime === "number" && !isNaN(targetTime)) {
    const timeDiff = Math.abs(video.currentTime - targetTime);
    if (timeDiff > 0.35) {
      video.currentTime = targetTime;
    }
  }

  if (payload.rate && video.playbackRate !== payload.rate) {
    video.playbackRate = payload.rate;
  }

  if (payload.action === "play") {
    if (video.paused) {
      video.play().catch(() => {});
    }
  } else if (payload.action === "pause") {
    if (!video.paused) {
      video.pause();
    }
  }
}

// Initial setup: eagerly bind video elements & poll for single-page app dynamic video loads
function init() {
  const video = findBestVideo();
  if (video) attachVideoListeners(video);
}

init();
setInterval(init, 1000);

// Observe DOM mutations for newly inserted video elements
const observer = new MutationObserver(() => init());
if (document.body || document.documentElement) {
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// Handle incoming messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "remote_state") {
    applyRemoteState(message.payload);
    return;
  }

  if (message.type === "get_current_state") {
    const video = findBestVideo();
    if (video) {
      sendResponse({
        paused: video.paused,
        time: video.currentTime,
        rate: video.playbackRate
      });
    } else {
      sendResponse(null);
    }
    return true;
  }

  if (message.type === "trigger_control") {
    const video = findBestVideo();
    if (!video) return;
    attachVideoListeners(video);

    if (message.action === "toggle") {
      if (video.paused) video.play();
      else video.pause();
    } else if (message.action === "seek_forward") {
      video.currentTime += 10;
    } else if (message.action === "seek_back") {
      video.currentTime -= 10;
    } else if (message.action === "toggle_mute") {
      video.muted = !video.muted;
    }
    return;
  }
});