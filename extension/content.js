// extension/content.js
// Handles HTML5 <video> state extraction and synchronization on web pages.

let isRemoteChange = false;
let seekTimeout = null;

function findBestVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;

  // Prefer playing video or largest video element on screen
  return videos.reduce((best, v) => {
    const area = v.offsetWidth * v.offsetHeight;
    const bestArea = best ? best.offsetWidth * best.offsetHeight : 0;
    if (!v.paused) return v;
    return area > bestArea ? v : best;
  }, null);
}

function attachVideoListeners(video) {
  if (!video || video.dataset.watchsyncAttached) return;
  video.dataset.watchsyncAttached = "true";

  const events = ["play", "pause", "seeked", "ratechange"];
  events.forEach((evt) => {
    video.addEventListener(evt, () => {
      if (isRemoteChange) return;
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
  isRemoteChange = true;

  if (seekTimeout) clearTimeout(seekTimeout);

  const targetTime = payload.time;
  const timeDiff = Math.abs(video.currentTime - targetTime);
  const needsSeek = timeDiff > 0.4;

  if (needsSeek) {
    video.currentTime = targetTime;
  }

  if (payload.rate && video.playbackRate !== payload.rate) {
    video.playbackRate = payload.rate;
  }

  const playVideo = () => {
    if (video.paused) {
      video.play().catch((err) => {
        console.warn("WatchSync: Play prevented or waiting for interaction", err);
      });
    }
  };

  if (payload.action === "play") {
    // Attempt play immediately
    playVideo();

    if (needsSeek) {
      // Re-trigger play once the browser finishes buffering the target seek frame
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        playVideo();
        setTimeout(() => { isRemoteChange = false; }, 150);
      };
      video.addEventListener("seeked", onSeeked, { once: true });

      // Fallback timeout in case the seeked event delays or doesn't fire
      seekTimeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        playVideo();
        isRemoteChange = false;
      }, 800);
      return;
    }
  } else if (payload.action === "pause") {
    if (!video.paused) {
      video.pause();
    }
  }

  seekTimeout = setTimeout(() => {
    isRemoteChange = false;
  }, 300);
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
    }
    return;
  }
});

// Observe DOM changes to attach listeners to dynamic single-page app players (e.g., YouTube, Netflix)
const observer = new MutationObserver(() => {
  const video = findBestVideo();
  if (video) attachVideoListeners(video);
});

if (document.body || document.documentElement) {
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}