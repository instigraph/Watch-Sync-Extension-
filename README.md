# WatchSync — Cross-device playback sync, peer-to-peer (MVP scaffold)

Syncs play/pause/seek across paired browsers over a direct WebRTC connection
— the room's creator ("host") relays between joined devices ("peers")
directly; a small signaling server only brokers the initial handshake and
never sees playback data. The extension runs on any site and only becomes
active where it actually finds a `<video>` element, so it works on YouTube,
Netflix, Prime Video, Disney+, Hotstar, and — via a generic fallback — most
other streaming sites without needing a hardcoded entry for each one.

## 1. Run the signaling server

```bash
cd signaling-server
npm install
npm start
```

This starts a WebSocket server on `ws://localhost:8080`. Unlike the earlier
version of this project, this server does **not** relay playback data or
hold any room state — it only forwards the WebRTC handshake (SDP offer/
answer/ICE candidates) needed for two browsers to open a direct peer-to-peer
data channel. Once that handshake completes, this server has nothing left
to do for that pair. Deploy it somewhere reachable (Render, Fly.io, Railway,
a small VPS) and use `wss://` (TLS) once public — Chrome extensions can't
open plain `ws://` connections to non-localhost hosts under Manifest V3's
default CSP.

## 2. Point the extension at your signaling server

In `extension/offscreen.js`, set:

```js
const SIGNAL_URL = "wss://your-deployed-signaling-server.example.com";
```

## 3. Load the extension

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Add real icon files under `extension/icons/` (16/48/128px PNGs) or remove
   the `icons` block from `manifest.json` if you don't have any yet.

## 4. Pair two (or more) devices

1. On device A, click the extension icon → **Create Room** → note the
   6-digit code. This device becomes the room's **host**: it's the one
   other devices' data channels connect *to*, and the one relaying between
   them. Room state (current stream URL, last playback position) lives only
   in this device's memory — nothing is stored on the signaling server.
2. On devices B, C, ... click the extension icon → enter that code → **Join
   Room**. Each joining device (a **peer**) opens a direct WebRTC data
   channel to the host. Playback state and stream changes flow
   peer → host → other peers, entirely outside the signaling server once
   connected.

Because the host is a real participant's browser rather than infrastructure
you run, **the room only exists while the host stays connected** — closing
the host's browser (or losing its connection) ends the room for everyone
currently in it. There's no host migration/failover in this version; see
"Known limitations."

## 5. Set a common stream for everyone in the room

Once in a room, the popup has a **Common stream** section:

- **Sync Room to This Tab** — sends the current tab's URL *and* its exact
  playback position (time, paused/playing) to everyone in the room; their
  browsers navigate there and jump straight to that spot, rather than
  starting from 0:00.
- Or paste any URL into the field and click **Send URL to Room** — this one
  starts everyone fresh at 0:00 (there's no "current position" to send for
  a URL you didn't pull from an open tab).

Anyone in the room can set the stream, not just whoever created it — it's a
"we're all watching this now" broadcast, not a host-only control. Joining a
room that already has a stream set navigates you there automatically and
catches you up to the last known playback position the same way.

## 6. Keyboard shortcuts (control playback without touching the site's UI)

Three global shortcuts are registered when the extension loads:

| Shortcut | Action |
|---|---|
| `Alt+Shift+P` | Play / pause (toggles, synced to the room) |
| `Alt+Shift+→` | Seek forward 10s (synced to the room) |
| `Alt+Shift+←` | Seek back 10s (synced to the room) |

These are deliberately unusual combinations so they don't collide with the
streaming site's own keybindings (plain Space/←/→ are left alone — the site
still handles those normally for local-only scrubbing if you want that).
Anyone in the room can use them; the action applies to whichever tab that
device currently has open. You can rebind them at `chrome://extensions/shortcuts`
if a combination conflicts with something else on your system.

## How it works

- `content.js` runs on every page but gives up scanning after 15s if no
  `<video>` element ever shows up, so it's cheap on non-streaming sites.
- **Primary signal**: native `<video>` events (`play`/`pause`/`seeked`/
  `ratechange`). This alone covers the vast majority of sites, since nearly
  every player — even a heavily custom-skinned one — wraps a real HTML5
  `<video>` element under the hood.
- **Button crawling (fallback)**: separately, the script also locates the
  page's actual play/pause control, either via a known selector for a
  handful of major platforms (`SITE_PROFILES` in `content.js`) or, for
  everything else, a generic scan for buttons whose `aria-label`, `title`,
  `data-testid`/`data-uia`, or class name contains "play"/"pause". This scan
  walks into open shadow roots too, since several platforms render controls
  there. This crawler is used two ways:
  1. **Applying remote state**: it first tries `video.play()`/`video.pause()`
     directly (cheap, works on most sites). If the video's state hasn't
     actually flipped ~300ms later, it dispatches a synthetic click on the
     crawled button instead — some players ignore or revert direct API calls
     and only respond to a real interaction with their own control.
  2. **Capturing local state**: a click listener on the crawled button also
     reports state, as a backup in case a given player doesn't reliably fire
     native `play`/`pause` events on the underlying `<video>` element.
- **`offscreen.js`** (running inside a hidden `chrome.offscreen` document,
  because `RTCPeerConnection` isn't available in a Manifest V3 service
  worker) holds the actual sync topology. Important platform constraint:
  offscreen documents can **only** use `chrome.runtime` (for messaging) —
  not `chrome.storage`, not `chrome.tabs`, nothing else. So `offscreen.js`
  never touches storage or tabs directly; whenever it needs either, it
  sends a message to `background.js` (which has full API access) and gets
  a reply.
  - The **host** keeps one `RTCPeerConnection` + data channel per joined
    peer. Any `state` or `set_stream` message it receives from one peer is
    relayed to every *other* connected peer's data channel, and applied to
    the host's own tab (via a proxied request to `background.js`). The host
    is the only place `streamUrl`/`lastState` are held in memory.
  - A **peer** keeps a single `RTCPeerConnection` to the host, sends its
    local state there, and applies whatever the host sends back.
  - A newly opened data channel triggers a `room_info` message from the
    host (current URL + last playback position) so a joining peer catches
    up immediately.
- **`signaling-server/server.js`** only brokers the WebRTC handshake — SDP
  offer/answer and ICE candidates — between a host and each joining peer.
  It holds no room state and never sees a `state` or `set_stream` message;
  those only ever travel over the WebRTC data channels once established.
- **`background.js`** owns everything `offscreen.js` can't touch: it
  creates/restores the offscreen document, persists `roomCode`/`role`/
  `deviceId` to `chrome.storage` (and restores them after a browser
  restart, telling the offscreen document to resume via a `begin`
  message), performs all `chrome.tabs` operations on the offscreen
  document's behalf (navigating the synced tab, applying remote state to
  it, reading the active tab's URL *and current playback position* for
  "sync to this tab"), routes popup ↔ offscreen messages, and owns the
  keyboard shortcuts.
- **Carrying playback position along with the URL**: setting a stream from
  the current tab (rather than a pasted URL) queries that tab's `content.js`
  for its exact `currentTime`/paused state via a `get_current_state`
  message, and that gets bundled into the `navigate`/`set_stream`/
  `room_info` messages so the receiving side jumps straight to the right
  spot instead of starting at 0:00.
- **Heartbeat drift correction**: discrete play/pause/seek events alone
  don't stop two videos from *slowly* drifting apart (slightly different
  buffering, frame timing, etc.), since nothing re-checks position between
  events. `content.js` reports its position every 5s while playing (tagged
  `heartbeat`), which `applyRemote` uses purely for the drift check — it
  never triggers a play/pause action, just a hard-seek if drift exceeds 1s.
- Drift correction: when a remote event arrives, if the local video's
  `currentTime` differs from the reported time by more than 1 second, it
  hard-seeks to match before applying play/pause.
- Echo suppression: after applying a remote event, local events are ignored
  for 500ms so the resulting native `play`/`pause`/`seeked` firing doesn't
  bounce back to the peer.

## Known limitations (next steps)

- **No host migration**: if the host disconnects, the room ends — peers
  get notified (`host_left`) but there's no promotion of a peer to host and
  no reconnection to a new host. Whoever wants to keep watching together has
  to create a fresh room. This is the direct tradeoff of not running
  always-on server infrastructure.
- **Some networks need a TURN server**: WebRTC first tries a direct
  connection (helped by the public STUN server in `ICE_SERVERS`), but
  roughly 15–20% of real-world network pairs — symmetric NATs, some
  corporate/mobile networks — can't establish one and need a TURN relay as
  fallback. This scaffold ships with STUN only, so those pairings simply
  won't connect. If you hit this, add a TURN server's URL/credentials to
  `ICE_SERVERS` in `offscreen.js` (the comment there shows the shape) —
  note a TURN relay does see encrypted-but-relayed traffic pass through it,
  so it's a partial return to "a server in the path," just not one that can
  read the data (it's still just ferrying the WebRTC packets).
- **Signaling server has no auth**: anyone who knows a room code can send a
  `join` for it and the server will forward the request to the host, who
  then unconditionally starts a WebRTC handshake with them. Fine for
  personal use with codes shared privately; add a shared secret or
  short-lived codes if you want to harden it.
- **"Synced tab" is per-browser, not per-window**: `offscreen.js` tracks a
  single `syncedTabId` per browser install (the tab that last reported local
  state, or the one it last navigated). If you have the target site open in
  multiple tabs/windows on the same device, only one is treated as "the"
  synced player. Fine for the intended use (one device, one viewer, one
  stream) but worth knowing.
- **Late-joiner catch-up is best-effort**: after navigating a joining
  device to the room's current URL, the extension waits 1.5s for the new
  page's player to initialize before applying the last known play/pause
  state and seek position. Slow-loading pages (or ones that take longer to
  mount their `<video>`) may miss that window — the regular drift-correction
  on the next play/pause/seek event will still pull them back in sync,
  just not instantly.
- **Keyboard shortcuts need the tab focused**: `chrome.commands` shortcuts
  fire at the browser level, but Chrome still requires the extension's
  target tab to be in the active window for `chrome.tabs.sendMessage` to
  reach it reliably. If the synced tab isn't focused, the shortcut may not
  do anything.
- **Broad host permission**: the extension now requests `*://*/*` and a
  content script on every page, which Chrome will show as "Read and change
  all your data on all websites" when loading it. That's required to cover
  arbitrary streaming sites without a hardcoded list; if you'd rather limit
  the blast radius, swap `*://*/*` back to an explicit domain list in
  `manifest.json` (both `host_permissions` and the content script `matches`)
  for just the sites you actually use.
- **Synthetic clicks aren't "real" user gestures**: browsers' autoplay
  policies only grant relaxed autoplay/audio permissions to *trusted* input
  (an actual mouse click from the OS), not a script-dispatched `MouseEvent`.
  Most players just check their own internal click handler and don't care
  about that distinction, so the click-fallback works in practice — but a
  site that specifically gates on browser-level "user activation" for its
  play button may still refuse a remote-triggered play. There's no clean
  workaround for that beyond requiring the user to click play once locally.
- **No accessible controls**: a small number of players render entirely to
  `<canvas>` with no DOM buttons and no `<video>` element (e.g. some custom
  WebGL/WASM players) — the crawler has nothing to find there. Rare among
  mainstream streaming sites, but it exists.
- **Selector drift**: platform UIs change their markup periodically, which
  can silently break both the `SITE_PROFILES` selectors and matches the
  generic scan finds. If sync stops working on a specific site, the first
  thing to check is whether `document.querySelector(...)` for that site's
  entry in `SITE_PROFILES` still returns something in the DevTools console.
- **MV3 service worker lifetime — mostly resolved**: the earlier version of
  this project ran its WebSocket in the background service worker, which
  Chrome unloads after ~30s idle. That's now moot for the WebRTC/signaling
  logic since it lives in the offscreen document instead, which persists
  independently of the service worker's lifecycle. The background service
  worker itself can still be unloaded/restarted freely — it has no
  long-lived state to lose (it just recreates the offscreen document on
  demand via `chrome.runtime.onStartup` / first message).
- **DRM platforms (Netflix/Prime/Disney+)**: the `<video>` element's
  `play()`/`pause()`/`currentTime` are controllable via JS even though the
  decrypted stream is DRM-protected — but these sites frequently swap out or
  re-render the video element (ads, quality changes, SPA navigation). The
  `MutationObserver` in `content.js` re-attaches to a new video element, but
  you'll likely need to add per-site tweaks (e.g. Netflix sometimes nests the
  video in a shadow DOM or iframe that needs `all_frames: true`, already set).
- **No content matching check**: the extension doesn't verify both devices
  are watching the *same* title — that's on the user for now. A nice
  follow-up is exchanging a page-title/video-id fingerprint on join and
  warning if they don't match.
- **Ads**: YouTube/platform ads will cause a `pause`/`play` or a jump that
  looks like a seek. The suppression window may need to be longer around ad
  boundaries — treat `waiting`/`stalled` events as "hold sync" states if this
  becomes annoying in practice.

## File map

```
extension/
  manifest.json      MV3 manifest, permissions, content script matches, commands
  background.js      Offscreen document lifecycle, popup message routing, keyboard commands
  offscreen.js        WebRTC host/peer logic, signaling client, tab navigation/sync
  offscreen.html       Hidden document shell that loads offscreen.js
  content.js          Video element detection + button-crawl fallback + event capture/apply
  popup.html/js       Pairing UI (create/join/leave room, set common stream, status)
signaling-server/
  server.js           WebRTC handshake broker only — no room/playback state
  package.json
```
