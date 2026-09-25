// signaling-server/server.js
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*"
  });
  res.end("WatchSync Signaling Server is active");
});

const wss = new WebSocket.Server({ server });

// roomCode -> { host: WebSocket|null, peers: Map<deviceId, WebSocket> }
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, peers: new Map() });
  return rooms.get(code);
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      ws.room = msg.room;
      ws.deviceId = msg.deviceId;
      ws.role = msg.role; // "host" | "peer"

      if (msg.role === "host") {
        const room = getRoom(msg.room);
        room.host = ws;
        send(ws, { type: "host_registered" });
        return;
      }

      // Peer validation: Check if room exists AND host is connected
      if (!rooms.has(msg.room) || !rooms.get(msg.room).host) {
        send(ws, { type: "no_host" });
        return;
      }

      const room = rooms.get(msg.room);
      room.peers.set(msg.deviceId, ws);
      send(ws, { type: "join_success" });
      send(room.host, { type: "peer_wants_join", from: msg.deviceId });
      return;
    }

    if (msg.type === "signal") {
      const room = rooms.get(ws.room);
      if (!room) return;
      const target = msg.to === "host" ? room.host : room.peers.get(msg.to);
      if (target) {
        send(target, { type: "signal", from: ws.deviceId, data: msg.data });
      }
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.room);
    if (!room) return;

    if (ws.role === "host") {
      for (const peer of room.peers.values()) send(peer, { type: "host_left" });
      rooms.delete(ws.room); // Remove room when host leaves
    } else if (ws.role === "peer") {
      room.peers.delete(ws.deviceId);
      if (room.host) send(room.host, { type: "peer_disconnected", from: ws.deviceId });
    }
  });
});

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WatchSync signaling server running on port ${PORT}`);
});