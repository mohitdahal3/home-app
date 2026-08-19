const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const db = require("./database");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const USERS_JSON_PATH = path.join(__dirname, "users.json");

// Tombstone lifetime: 24 hours. After this, tombstones are garbage-collected.
const TOMBSTONE_TTL = 24 * 60 * 60 * 1000;

// Garbage-collect old tombstones every hour.
setInterval(() => {
  db.cleanupTombstones(TOMBSTONE_TTL);
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

// Connected & authenticated clients. Map<WebSocket, { username }>
const clients = new Map();

// ---------------------------------------------------------------------------
// JSON Auth Helpers
// ---------------------------------------------------------------------------

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_JSON_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Auth] Failed to read users.json:", err.message);
    return [];
  }
}

function authenticate(passcode) {
  const users = loadUsers();
  const match = users.find((u) => u.passcode === String(passcode));
  return match ? match.username : null;
}

// ---------------------------------------------------------------------------
// Action Diary Processing
// ---------------------------------------------------------------------------

function processDiary(actions) {
  // Sort by timestamp (oldest first) for deterministic replay.
  const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp);

  for (const action of sorted) {
    switch (action.type) {
      case "ADD":
        db.handleAdd(action);
        break;
      case "CHECK":
        db.handleCheck(action);
        break;
      case "UNCHECK":
        db.handleUncheck(action);
        break;
      case "DELETE":
        db.handleDelete(action);
        break;
      default:
        console.warn(`Unknown action type: ${action.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Broadcast Helpers
// ---------------------------------------------------------------------------

function buildSnapshot() {
  const users = loadUsers().map((u) => u.username);
  return {
    type: "SYNC",
    list: db.getAllItems(),
    users,
  };
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastSnapshot() {
  const snapshot = buildSnapshot();
  for (const [ws] of clients) {
    send(ws, snapshot);
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[Home Server] Listening on ws://localhost:${PORT}`);
  console.log(`[Home Server] Users loaded: ${loadUsers().map((u) => u.username).join(", ")}`);
});

wss.on("connection", (ws) => {
  console.log("[Home Server] New connection");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: "ERROR", message: "Invalid JSON" });
      return;
    }

    // ----- AUTH -----
    if (msg.type === "AUTH") {
      const username = authenticate(msg.passcode);
      if (!username) {
        send(ws, { type: "AUTH_FAIL", message: "Invalid passcode" });
        ws.close();
        return;
      }

      clients.set(ws, { username });
      console.log(`[Auth] ${username} authenticated`);
      const users = loadUsers().map((u) => u.username);
      send(ws, { type: "AUTH_OK", username, users });

      // Immediately send the current master list so the client is up to date.
      send(ws, buildSnapshot());
      return;
    }

    // All other messages require authentication.
    if (!clients.has(ws)) {
      send(ws, { type: "ERROR", message: "Not authenticated" });
      ws.close();
      return;
    }

    const { username } = clients.get(ws);

    // ----- DIARY FLUSH (with clock drift correction) -----
    if (msg.type === "DIARY") {
      if (!Array.isArray(msg.actions)) {
        send(ws, { type: "ERROR", message: "DIARY.actions must be an array" });
        return;
      }

      console.log(`[Diary] Received ${msg.actions.length} action(s) from ${username}`);

      // --- Clock drift correction ---
      const serverNow = Date.now();
      const clientTime = msg.clientTime || serverNow;
      const clockOffset = serverNow - clientTime;

      if (Math.abs(clockOffset) > 2000) {
        console.log(`[Clock] ${username} drift: ${clockOffset > 0 ? "+" : ""}${clockOffset}ms`);
      }

      const adjusted = msg.actions.map((a) => ({
        ...a,
        username,
        timestamp: a.timestamp + clockOffset,
      }));

      processDiary(adjusted);

      // After processing, broadcast the updated list to everyone.
      broadcastSnapshot();
      return;
    }

    // ----- REQUEST SYNC (client wants the latest list) -----
    if (msg.type === "REQUEST_SYNC") {
      send(ws, buildSnapshot());
      return;
    }

    // ----- CLEAR CHECKED (batch-remove all checked items from a list) -----
    if (msg.type === "CLEAR_CHECKED") {
      const listType = msg.listType || "group";
      db.clearChecked(listType, username);
      broadcastSnapshot();
      return;
    }

    send(ws, { type: "ERROR", message: `Unknown message type: ${msg.type}` });
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`[Home Server] ${info.username} disconnected`);
    }
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("[WS Error]", err.message);
    clients.delete(ws);
  });
});

console.log("[Home Server] Starting...");
