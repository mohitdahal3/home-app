const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const USERS_CSV_PATH = path.join(__dirname, "users.csv");

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

// Master grocery list keyed by a unique ID.
// Each entry: { id, text, checked, addedBy, checkedBy, createdAt }
const masterList = new Map();

// Monotonically increasing ID counter (simple for in-memory mode).
let nextId = 1;

// Connected & authenticated clients. Map<WebSocket, { username }>
const clients = new Map();

// ---------------------------------------------------------------------------
// CSV Auth Helpers
// ---------------------------------------------------------------------------

/**
 * Read users.csv and return an array of { username, passcode } objects.
 * Re-reads the file on every call so you can hot-edit the CSV without
 * restarting the server.
 */
function loadUsers() {
  const csv = fs.readFileSync(USERS_CSV_PATH, "utf-8");
  return parse(csv, { columns: true, skip_empty_lines: true, trim: true });
}

/**
 * Validate a passcode against the CSV.
 * Returns the username string if valid, or null if not.
 */
function authenticate(passcode) {
  const users = loadUsers();
  const match = users.find((u) => u.passcode === String(passcode));
  return match ? match.username : null;
}

// ---------------------------------------------------------------------------
// Action Diary Processing
// ---------------------------------------------------------------------------

/**
 * Process a batch of actions from a client's diary queue.
 *
 * Each action is an object:
 *   { type: "ADD" | "CHECK", text?: string, itemId?: string,
 *     timestamp: number, username: string, listType?: "group" | "personal" }
 *
 * Actions are sorted by timestamp before processing so that concurrent
 * offline edits resolve deterministically.
 */
function processDiary(actions) {
  // Sort by timestamp (oldest first) for deterministic replay.
  const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp);

  for (const action of sorted) {
    switch (action.type) {
      case "ADD":
        handleAdd(action);
        break;
      case "CHECK":
        handleCheck(action);
        break;
      case "DELETE":
        handleDelete(action);
        break;
      default:
        console.warn(`Unknown action type: ${action.type}`);
    }
  }
}

/**
 * ADD action — creates a new item OR merges with an existing item that has
 * the exact same text (case-sensitive) AND the same listType.
 *
 * Duplicate rule from CLAUDE.md:
 *   "If two users add the exact same string, the server merges them into a
 *    single item with one ID."
 */
function handleAdd(action) {
  const { text, timestamp, username, listType = "group" } = action;

  // Search for an existing un-checked item with identical text + listType.
  for (const [, item] of masterList) {
    if (item.text === text && item.listType === listType && !item.checked) {
      // Duplicate detected — merge by keeping the earlier timestamp.
      if (timestamp < item.createdAt) {
        item.createdAt = timestamp;
        item.addedBy = username;
      }
      console.log(`  Merged duplicate "${text}" into item ${item.id}`);
      return; // Nothing else to do.
    }
  }

  // No duplicate — create a new item.
  const id = String(nextId++);
  masterList.set(id, {
    id,
    text,
    checked: false,
    addedBy: username,
    checkedBy: null,
    listType,
    createdAt: timestamp,
  });
  console.log(`  Added item ${id}: "${text}" (${listType})`);
}

/**
 * CHECK action — marks an item as checked (purchased).
 * Matches by itemId first; falls back to text match for offline-created items
 * whose server-side ID the client may not know yet.
 */
function handleCheck(action) {
  const { itemId, text, timestamp, username } = action;

  let item = null;

  // Try by ID first.
  if (itemId && masterList.has(itemId)) {
    item = masterList.get(itemId);
  }

  // Fallback: match by text (first unchecked occurrence).
  if (!item && text) {
    for (const [, entry] of masterList) {
      if (entry.text === text && !entry.checked) {
        item = entry;
        break;
      }
    }
  }

  if (item) {
    item.checked = true;
    item.checkedBy = username;
    console.log(`  Checked item ${item.id}: "${item.text}" by ${username}`);
  } else {
    console.warn(`  CHECK failed — no matching item for id=${itemId} text="${text}"`);
  }
}

/**
 * DELETE action — removes an item from the master list entirely.
 * Matches by itemId first; falls back to text match.
 */
function handleDelete(action) {
  const { itemId, text, username } = action;

  let targetId = null;

  // Try by ID first.
  if (itemId && masterList.has(itemId)) {
    targetId = itemId;
  }

  // Fallback: match by text.
  if (!targetId && text) {
    for (const [id, entry] of masterList) {
      if (entry.text === text) {
        targetId = id;
        break;
      }
    }
  }

  if (targetId) {
    const item = masterList.get(targetId);
    masterList.delete(targetId);
    console.log(`  Deleted item ${targetId}: "${item.text}" by ${username}`);
  } else {
    console.warn(`  DELETE failed — no matching item for id=${itemId} text="${text}"`);
  }
}

// ---------------------------------------------------------------------------
// Broadcast Helpers
// ---------------------------------------------------------------------------

/** Build a snapshot of the master list to send to clients. */
function buildSnapshot() {
  const users = loadUsers().map((u) => u.username);
  return {
    type: "SYNC",
    list: Array.from(masterList.values()),
    users,
  };
}

/** Send a message object to a single WebSocket client. */
function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Broadcast the current master list to every authenticated client. */
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

    // ----- DIARY FLUSH -----
    if (msg.type === "DIARY") {
      // msg.actions is the array of queued actions from the client.
      if (!Array.isArray(msg.actions)) {
        send(ws, { type: "ERROR", message: "DIARY.actions must be an array" });
        return;
      }

      console.log(`[Diary] Received ${msg.actions.length} action(s) from ${username}`);

      // Tag each action with the authenticated username for safety.
      const tagged = msg.actions.map((a) => ({ ...a, username }));
      processDiary(tagged);

      // After processing, broadcast the updated list to everyone.
      broadcastSnapshot();
      return;
    }

    // ----- REQUEST SYNC (client wants the latest list) -----
    if (msg.type === "REQUEST_SYNC") {
      send(ws, buildSnapshot());
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
