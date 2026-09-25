// content.js
// Runs on (almost) every page. Bails out quickly if there's no video player.
// Primary sync signal is the <video> element's native events, which is
// reliable on essentially all sites since they all wrap an HTML5 <video>
// even when the UI is a custom skin. The "button crawling" layer below is
// the fallback for two cases the video element alone can't solve:
//   1. Some players ignore or block a programmatic video.play()/pause()
//      call (autoplay-policy quirks, internal state that isn't just the
//      element's own paused flag) — clicking their real control button
//      is more reliable than calling the API directly.
//   2. Sites that briefly swap out the entire player DOM (ads, quality
//      switches) where re-finding "the play/pause button" by label is
//      more stable than re-finding "the video".

(function () {
  const DRIFT_TOLERANCE_SEC = 1.0;
  const SUPPRESS_ECHO_MS = 500;
  const NO_VIDEO_GIVEUP_MS = 15000; // stop scanning if nothing shows up
  const VERIFY_DELAY_MS = 300; // time to check whether play()/pause() "took"
  const HEARTBEAT_MS = 5000; // periodic drift-correction while playing

  let video = null;
  let controls = { play: null, pause: null }; // may point to the same toggle button
  let suppressUntil = 0;
  let scanTimer = null;
  let gaveUp = false;

  // Per-site selector hints. Most sites are covered by the generic
  // label-based scan below; these just make the match faster/more precise
  // on platforms with known, stable markup.
  const SITE_PROFILES = {
    "youtube.com": { toggle: ".ytp-play-button" },
    "netflix.com": { toggle: '[data-uia="control-play-pause-button"]' },
    "primevideo.com": { toggle: ".atvwebplayersdk-playpause-button" },
    "disneyplus.com": { toggle: 'button[data-testid="play-pause-icon"]' },
    "hotstar.com": { toggle: '[data-testid="control-bar-play"]' },
    "hulu.com": { toggle: '[class*="PlayPauseButton" i]' },
    "max.com": { toggle: '[data-testid="play-pause-button"]' },
    "peacocktv.com": { toggle: 'button[aria-label*="play" i], button[aria-label*="pause" i]' },
    "paramountplus.com": { toggle: '[data-testid="play-button"], [data-testid="pause-button"]' },
    "tv.apple.com": { toggle: 'button[aria-label*="play" i], button[aria-label*="pause" i]' }
  };

  // Generic fallback, tried on any site not in the profile list above (or
  // if the profile selector doesn't resolve to anything).
  const GENERIC_SELECTORS = [
    'button[aria-label="Play"]',
    'button[aria-label="Pause"]',
    'button[aria-label*="play" i]',
    'button[aria-label*="pause" i]',
    'button[title*="play" i]',
    'button[title*="pause" i]',
    '[data-testid*="play" i]',
    '[data-testid*="pause" i]',
    '[data-uia*="play-pause" i]',
    '[class*="play-pause" i]',
    '[class*="playpause" i]'
  ];

  start();

  function start() {
    scan();
    const observer = new MutationObserver(() => {
      if (!gaveUp) scan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    scanTimer = setTimeout(() => {
      if (!video) {
        gaveUp = true; // no player on this page — stop doing work
      }
    }, NO_VIDEO_GIVEUP_MS);
  }

  function scan() {
    findVideo();
    findControls();
  }

  function findVideo() {
    const found = deepQuerySelector("video");
    if (found && found !== video) {
      video = found;
      attachVideoListeners(video);
      clearTimeout(scanTimer); // found one — cancel the give-up timer
    }
  }

  function findControls() {
    const hostname = location.hostname.replace(/^www\./, "");
    const profileKey = Object.keys(SITE_PROFILES).find((k) => hostname.endsWith(k));
    let toggle = null;

    if (profileKey) {
      toggle = deepQuerySelector(SITE_PROFILES[profileKey].toggle);
    }
    if (!toggle) {
      for (const sel of GENERIC_SELECTORS) {
        toggle = deepQuerySelector(sel);
        if (toggle) break;
      }
    }
    if (toggle) {
      controls.play = toggle;
      controls.pause = toggle; // same element on nearly every player: it's a toggle
      if (!controls._listenerAttached) {
        toggle.addEventListener("click", () => {
          // A real user click on the actual button — treat like a native
          // video event for local reporting, in case this player doesn't
          // reliably fire play/pause on the <video> element itself.
          setTimeout(() => {
            if (video && Date.now() >= suppressUntil) {
              reportLocal(video.paused ? "pause" : "play", video.currentTime, video.playbackRate);
            }
          }, 50);
        });
        controls._listenerAttached = true;
      }
    }
  }

  // Walks light DOM + open shadow roots (Netflix, Disney+, and several
  // others render their controls inside shadow DOM).
  function deepQuerySelector(selector) {
    try {
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch {
      return null;
    }
    return searchShadow(document.body, selector);
  }

  function searchShadow(root, selector) {
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) {
        try {
          const match = node.shadowRoot.querySelector(selector);
          if (match) return match;
        } catch {}
        const nested = searchShadow(node.shadowRoot, selector);
        if (nested) return nested;
      }
      node = walker.nextNode();
    }
    return null;
  }

  function attachVideoListeners(v) {
    v.addEventListener("play", () => reportLocal("play", v.currentTime, v.playbackRate));
    v.addEventListener("pause", () => reportLocal("pause", v.currentTime, v.playbackRate));
    v.addEventListener("seeked", () => reportLocal("seek", v.currentTime, v.playbackRate));
    v.addEventListener("ratechange", () => reportLocal("rate", v.currentTime, v.playbackRate));
  }

  // Play/pause/seek events only fire on discrete state changes, so two
  // videos that started roughly together but at slightly different exact
  // instants (or with slightly different effective playback speed —
  // buffering, frame drops) will slowly drift apart with nothing to correct
  // it. This periodically reports position while playing so applyRemote's
  // drift check has something to catch that drift against.
  setInterval(() => {
    if (video && !video.paused && Date.now() >= suppressUntil) {
      reportLocal("heartbeat", video.currentTime, video.playbackRate);
    }
  }, HEARTBEAT_MS);

  function reportLocal(action, time, rate) {
    if (Date.now() < suppressUntil) return;
    chrome.runtime.sendMessage({ type: "local_state", action, time, rate }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "remote_state") {
      applyRemote(message.payload);
    } else if (message.type === "trigger_control") {
      handleTriggerControl(message.action);
    } else if (message.type === "get_current_state") {
      // Asked (via background.js, when someone clicks "Sync Room to This
      // Tab") for this tab's exact playback position, so the room can carry
      // it along with the URL instead of joiners/peers starting from 0:00.
      sendResponse(video ? { time: video.currentTime, paused: video.paused, rate: video.playbackRate } : null);
    }
  });

  // Local, user-initiated actions from the global keyboard shortcuts
  // (see manifest.json "commands" + background.js chrome.commands listener).
  // These just act on the video directly — the existing native event
  // listeners (attachVideoListeners) pick up the resulting play/pause/seeked
  // event and report it to the room like any other local action.
  function handleTriggerControl(action) {
    if (!video) return;
    if (action === "toggle") {
      setPlayState(video.paused);
    } else if (action === "seek_forward") {
      video.currentTime = Math.min(video.currentTime + 10, video.duration || Infinity);
    } else if (action === "seek_back") {
      video.currentTime = Math.max(video.currentTime - 10, 0);
    }
  }

  function applyRemote(state) {
    if (!video) return;
    suppressUntil = Date.now() + SUPPRESS_ECHO_MS;

    const drift = Math.abs(video.currentTime - state.time);
    if (drift > DRIFT_TOLERANCE_SEC) {
      video.currentTime = state.time;
    }

    if (state.action === "rate") {
      if (video.playbackRate !== state.rate) video.playbackRate = state.rate;
      return;
    }
    if (state.action === "heartbeat") return; // drift already corrected above; not a play/pause command

    const wantPlaying = state.action === "play";
    if (wantPlaying === !video.paused) return; // already in the right state
    setPlayState(wantPlaying);
  }

  // Sets play/pause state, verifying it actually took effect and falling
  // back to a synthetic click on the real control button if not (some
  // players ignore or revert direct API calls). Used both for applying
  // remote state and for the local keyboard-shortcut toggle.
  function setPlayState(wantPlaying) {
    if (!video) return;
    if (wantPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }

    setTimeout(() => {
      const stillWrong = wantPlaying ? video.paused : !video.paused;
      if (stillWrong && controls.play) {
        clickElement(controls.play);
      }
    }, VERIFY_DELAY_MS);
  }

  function clickElement(el) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }
})();
