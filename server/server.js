const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const USERS_JSON_PATH = path.join(__dirname, "users.json");

// Tombstone lifetime: 24 hours. After this, tombstones are garbage-collected.
const TOMBSTONE_TTL = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

// Master grocery list keyed by a unique ID.
// Each entry: { id, text, checked, addedBy, checkedBy, listType, createdAt, checkedAt }
const masterList = new Map();

// Monotonically increasing ID counter (simple for in-memory mode).
let nextId = 1;

// Connected & authenticated clients. Map<WebSocket, { username }>
const clients = new Map();

// Tombstones: prevents offline clients from resurrecting deleted items.
// Key: "text|listType", Value: server-time timestamp when the item was deleted.
const tombstones = new Map();

// ---------------------------------------------------------------------------
// JSON Auth Helpers
// ---------------------------------------------------------------------------

/**
 * Read users.json and return an array of { username, passcode } objects.
 * Re-reads the file on every call so you can hot-edit the JSON without
 * restarting the server.
 */
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_JSON_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Auth] Failed to read users.json:", err.message);
    return [];
  }
}

/**
 * Validate a passcode against users.json.
 * Returns the username string if valid, or null if not.
 */
function authenticate(passcode) {
  const users = loadUsers();
  const match = users.find((u) => u.passcode === String(passcode));
  return match ? match.username : null;
}

// ---------------------------------------------------------------------------
// Tombstone Helpers
// ---------------------------------------------------------------------------

/**
 * Record that an item with the given text+listType was deleted at server-time.
 * This prevents stale ADD actions from resurrecting the item.
 */
function addTombstone(text, listType) {
  tombstones.set(`${text}|${listType}`, Date.now());
}

/**
 * Check if an ADD action should be rejected because the item was deleted
 * more recently than the action's (server-adjusted) timestamp.
 *
 * If the ADD is newer than the tombstone, the tombstone is cleared
 * (the user genuinely re-added the item after deletion).
 */
function isTombstoned(text, listType, adjustedTimestamp) {
  const key = `${text}|${listType}`;
  const deletedAt = tombstones.get(key);
  if (deletedAt === undefined) return false;

  if (adjustedTimestamp < deletedAt) {
    // The ADD happened before the deletion — it's a ghost. Reject it.
    return true;
  }

  // The ADD happened after the deletion — user genuinely re-added. Allow it.
  tombstones.delete(key);
  return false;
}

/** Remove tombstones older than TOMBSTONE_TTL. */
function cleanupTombstones() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, deletedAt] of tombstones) {
    if (now - deletedAt > TOMBSTONE_TTL) {
      tombstones.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Tombstones] Cleaned ${cleaned} stale tombstone(s)`);
  }
}

// Garbage-collect old tombstones every hour.
setInterval(cleanupTombstones, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Action Diary Processing
// ---------------------------------------------------------------------------

/**
 * Process a batch of actions from a client's diary queue.
 *
 * IMPORTANT: All timestamps should already be adjusted for client clock
 * drift before calling this function.
 *
 * Actions are sorted by timestamp before processing so that concurrent
 * offline edits from multiple devices resolve deterministically
 * (Last-Write-Wins based on server-adjusted timestamps).
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
      case "UNCHECK":
        handleUncheck(action);
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
 * Checks tombstones first to prevent ghost data from offline clients.
 *
 * Duplicate rule from CLAUDE.md:
 *   "If two users add the exact same string, the server merges them into a
 *    single item with one ID."
 */
function handleAdd(action) {
  const { text, timestamp, username, listType = "group" } = action;

  // Ghost data check: reject if this item was deleted more recently.
  if (isTombstoned(text, listType, timestamp)) {
    console.log(`  Rejected stale ADD "${text}" (tombstoned)`);
    return;
  }

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
    checkedAt: null,
  });
  console.log(`  Added item ${id}: "${text}" (${listType})`);
}

/**
 * CHECK action — marks an item as checked (purchased).
 * Uses Last-Write-Wins: only applies if the action's server-adjusted
 * timestamp is >= the item's last checkedAt.
 */
function handleCheck(action) {
  const { itemId, text, timestamp, username } = action;

  const item = findItem(itemId, text);

  if (item) {
    // Last-Write-Wins: only apply if this timestamp is newer.
    if (!item.checkedAt || timestamp >= item.checkedAt) {
      item.checked = true;
      item.checkedBy = username;
      item.checkedAt = timestamp;
      console.log(`  Checked item ${item.id}: "${item.text}" by ${username}`);
    } else {
      console.log(`  CHECK skipped (older timestamp) for "${item.text}"`);
    }
  } else {
    console.warn(`  CHECK failed — no matching item for id=${itemId} text="${text}"`);
  }
}

/**
 * UNCHECK action — marks an item as unchecked.
 * Uses Last-Write-Wins based on server-adjusted timestamp.
 */
function handleUncheck(action) {
  const { itemId, text, timestamp } = action;

  const item = findItem(itemId, text);

  if (item) {
    // Last-Write-Wins: only apply if this timestamp is newer.
    if (!item.checkedAt || timestamp >= item.checkedAt) {
      item.checked = false;
      item.checkedBy = null;
      item.checkedAt = timestamp;
      console.log(`  Unchecked item ${item.id}: "${item.text}"`);
    } else {
      console.log(`  UNCHECK skipped (older timestamp) for "${item.text}"`);
    }
  } else {
    console.warn(`  UNCHECK failed — no matching item for id=${itemId} text="${text}"`);
  }
}

/**
 * DELETE action — removes an item from the master list and creates a
 * tombstone to prevent ghost re-adds from offline clients.
 */
function handleDelete(action) {
  const { itemId, text, username } = action;

  const item = findItem(itemId, text);

  if (item) {
    addTombstone(item.text, item.listType);
    masterList.delete(item.id);
    console.log(`  Deleted item ${item.id}: "${item.text}" by ${username}`);
  } else {
    console.warn(`  DELETE failed — no matching item for id=${itemId} text="${text}"`);
  }
}

/**
 * Helper: find an item by ID first, then fallback to text match.
 */
function findItem(itemId, text) {
  // Try by ID first.
  if (itemId && masterList.has(itemId)) {
    return masterList.get(itemId);
  }

  // Fallback: match by text (first unchecked occurrence, then any).
  if (text) {
    // Prefer unchecked match.
    for (const [, entry] of masterList) {
      if (entry.text === text && !entry.checked) {
        return entry;
      }
    }
    // Any match.
    for (const [, entry] of masterList) {
      if (entry.text === text) {
        return entry;
      }
    }
  }

  return null;
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
      // The client includes its local Date.now() as msg.clientTime.
      // We compute the offset between server and client clocks, then
      // adjust all action timestamps so LWW comparisons use server time.
      // This prevents a phone with a fast/slow clock from winning unfairly.
      const serverNow = Date.now();
      const clientTime = msg.clientTime || serverNow; // fallback if missing
      const clockOffset = serverNow - clientTime;

      if (Math.abs(clockOffset) > 2000) {
        console.log(`[Clock] ${username} drift: ${clockOffset > 0 ? "+" : ""}${clockOffset}ms`);
      }

      // Tag each action with the username and adjust timestamps.
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
      let cleared = 0;

      for (const [id, item] of masterList) {
        if (item.listType === listType && item.checked) {
          addTombstone(item.text, item.listType);
          masterList.delete(id);
          cleared++;
        }
      }

      console.log(`[Clear] ${username} cleared ${cleared} checked items from "${listType}"`);
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
