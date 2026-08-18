import * as SQLite from "expo-sqlite";

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------
let db = null;

/**
 * Open (or create) the local SQLite database and ensure all tables exist.
 * Call this once at app startup before any other DB function.
 */
export function initDB() {
  db = SQLite.openDatabaseSync("home.db");

  // Items table — local cache of the grocery list.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS items (
      id          TEXT PRIMARY KEY,
      text        TEXT NOT NULL,
      checked     INTEGER DEFAULT 0,
      addedBy     TEXT,
      checkedBy   TEXT,
      listType    TEXT DEFAULT 'group',
      createdAt   INTEGER NOT NULL
    );
  `);

  // Action Diary queue — offline actions waiting to be flushed to the server.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS action_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      text        TEXT,
      itemId      TEXT,
      listType    TEXT,
      timestamp   INTEGER NOT NULL
    );
  `);

  // Session — stores login credentials for auto-reconnect.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS session (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Cached user list — so tabs work offline.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function saveSession(username, passcode) {
  db.runSync("INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)", [
    "username",
    username,
  ]);
  db.runSync("INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)", [
    "passcode",
    passcode,
  ]);
}

export function getSession() {
  const username = db.getFirstSync(
    "SELECT value FROM session WHERE key = ?",
    ["username"]
  );
  const passcode = db.getFirstSync(
    "SELECT value FROM session WHERE key = ?",
    ["passcode"]
  );
  if (username && passcode) {
    return { username: username.value, passcode: passcode.value };
  }
  return null;
}

export function clearSession() {
  db.runSync("DELETE FROM session");
}

// ---------------------------------------------------------------------------
// User list cache (for offline tab rendering)
// ---------------------------------------------------------------------------

export function saveUsers(usernames) {
  db.runSync("DELETE FROM users");
  for (const u of usernames) {
    db.runSync("INSERT OR REPLACE INTO users (username) VALUES (?)", [u]);
  }
}

export function getCachedUsers() {
  const rows = db.getAllSync("SELECT username FROM users");
  return rows.map((r) => r.username);
}

// ---------------------------------------------------------------------------
// Items CRUD
// ---------------------------------------------------------------------------

/** Get all items, optionally filtered by listType. */
export function getItems(listType) {
  if (listType) {
    return db.getAllSync(
      "SELECT * FROM items WHERE listType = ? ORDER BY createdAt DESC",
      [listType]
    );
  }
  return db.getAllSync("SELECT * FROM items ORDER BY createdAt DESC");
}

/** Add a new item to the local database. Returns the item object. */
export function addItem(text, listType, addedBy) {
  const id = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  const createdAt = Date.now();

  db.runSync(
    "INSERT INTO items (id, text, checked, addedBy, listType, createdAt) VALUES (?, ?, 0, ?, ?, ?)",
    [id, text, addedBy, listType, createdAt]
  );

  return { id, text, checked: 0, addedBy, checkedBy: null, listType, createdAt };
}

/** Mark an item as checked. */
export function checkItem(id, checkedBy) {
  db.runSync("UPDATE items SET checked = 1, checkedBy = ? WHERE id = ?", [
    checkedBy,
    id,
  ]);
}

/** Uncheck an item. */
export function uncheckItem(id) {
  db.runSync("UPDATE items SET checked = 0, checkedBy = NULL WHERE id = ?", [
    id,
  ]);
}

/** Delete an item. */
export function deleteItem(id) {
  db.runSync("DELETE FROM items WHERE id = ?", [id]);
}

/**
 * Replace the entire local items table with a server snapshot.
 * Called when we receive a SYNC message from the server.
 */
export function replaceAllItems(serverItems) {
  db.execSync("DELETE FROM items");
  for (const item of serverItems) {
    db.runSync(
      "INSERT OR REPLACE INTO items (id, text, checked, addedBy, checkedBy, listType, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        item.id,
        item.text,
        item.checked ? 1 : 0,
        item.addedBy || null,
        item.checkedBy || null,
        item.listType || "group",
        item.createdAt || Date.now(),
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// Action Diary (sync queue)
// ---------------------------------------------------------------------------

/** Log an action to the queue for later server flush. */
export function logAction(type, { text, itemId, listType }) {
  const timestamp = Date.now();
  db.runSync(
    "INSERT INTO action_queue (type, text, itemId, listType, timestamp) VALUES (?, ?, ?, ?, ?)",
    [type, text || null, itemId || null, listType || null, timestamp]
  );
}

/** Get all pending (un-synced) actions. */
export function getPendingActions() {
  return db.getAllSync("SELECT * FROM action_queue ORDER BY timestamp ASC");
}

/** Clear the action queue after a successful flush. */
export function clearActionQueue() {
  db.runSync("DELETE FROM action_queue");
}
