const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Setup & Initialization
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, "server.db");
const db = new Database(DB_PATH);

// Configure SQLite for better performance and reliability
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    checked INTEGER DEFAULT 0,
    addedBy TEXT,
    checkedBy TEXT,
    listType TEXT DEFAULT 'group',
    createdAt INTEGER NOT NULL,
    checkedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS tombstones (
    key TEXT PRIMARY KEY,
    deletedAt INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// Prepared Statements
// ---------------------------------------------------------------------------

// Tombstones
const stmtAddTombstone = db.prepare("INSERT OR REPLACE INTO tombstones (key, deletedAt) VALUES (?, ?)");
const stmtGetTombstone = db.prepare("SELECT deletedAt FROM tombstones WHERE key = ?");
const stmtDeleteTombstone = db.prepare("DELETE FROM tombstones WHERE key = ?");
const stmtCleanupTombstones = db.prepare("DELETE FROM tombstones WHERE ? - deletedAt > ?");

// Items - Queries
const stmtGetAllItems = db.prepare("SELECT * FROM items");
const stmtGetItemById = db.prepare("SELECT * FROM items WHERE id = ?");
const stmtGetItemByTextUnchecked = db.prepare("SELECT * FROM items WHERE text = ? AND checked = 0 LIMIT 1");
const stmtGetItemByTextAny = db.prepare("SELECT * FROM items WHERE text = ? LIMIT 1");
const stmtFindDuplicate = db.prepare("SELECT * FROM items WHERE text = ? AND listType = ? AND checked = 0 LIMIT 1");
const stmtGetCheckedItemsByListType = db.prepare("SELECT * FROM items WHERE listType = ? AND checked = 1");

// Items - Mutations
const stmtInsertItem = db.prepare(`
  INSERT INTO items (id, text, checked, addedBy, checkedBy, listType, createdAt, checkedAt)
  VALUES (@id, @text, @checked, @addedBy, @checkedBy, @listType, @createdAt, @checkedAt)
`);
const stmtUpdateItemMerge = db.prepare("UPDATE items SET createdAt = ?, addedBy = ? WHERE id = ?");
const stmtUpdateItemCheck = db.prepare("UPDATE items SET checked = 1, checkedBy = ?, checkedAt = ? WHERE id = ?");
const stmtUpdateItemUncheck = db.prepare("UPDATE items SET checked = 0, checkedBy = NULL, checkedAt = ? WHERE id = ?");
const stmtDeleteItem = db.prepare("DELETE FROM items WHERE id = ?");

// ---------------------------------------------------------------------------
// Tombstone API
// ---------------------------------------------------------------------------

function addTombstone(text, listType) {
  const key = `${text}|${listType}`;
  stmtAddTombstone.run(key, Date.now());
}

function isTombstoned(text, listType, adjustedTimestamp) {
  const key = `${text}|${listType}`;
  const row = stmtGetTombstone.get(key);
  if (!row) return false;

  if (adjustedTimestamp < row.deletedAt) {
    // The ADD happened before the deletion — it's a ghost.
    return true;
  }

  // The ADD happened after the deletion — user genuinely re-added.
  stmtDeleteTombstone.run(key);
  return false;
}

function cleanupTombstones(ttl) {
  const info = stmtCleanupTombstones.run(Date.now(), ttl);
  if (info.changes > 0) {
    console.log(`[Tombstones] Cleaned ${info.changes} stale tombstone(s)`);
  }
}

// ---------------------------------------------------------------------------
// Items API
// ---------------------------------------------------------------------------

function getAllItems() {
  const rows = stmtGetAllItems.all();
  // Map SQLite integers back to booleans for the app
  return rows.map(r => ({ ...r, checked: r.checked === 1 }));
}

function findItem(itemId, text) {
  if (itemId) {
    const item = stmtGetItemById.get(itemId);
    if (item) return { ...item, checked: item.checked === 1 };
  }

  if (text) {
    let item = stmtGetItemByTextUnchecked.get(text);
    if (item) return { ...item, checked: false };

    item = stmtGetItemByTextAny.get(text);
    if (item) return { ...item, checked: item.checked === 1 };
  }

  return null;
}

function handleAdd(action) {
  const { text, timestamp, username, listType = "group" } = action;

  if (isTombstoned(text, listType, timestamp)) {
    console.log(`  Rejected stale ADD "${text}" (tombstoned)`);
    return;
  }

  const existing = stmtFindDuplicate.get(text, listType);
  if (existing) {
    if (timestamp < existing.createdAt) {
      stmtUpdateItemMerge.run(timestamp, username, existing.id);
    }
    console.log(`  Merged duplicate "${text}" into item ${existing.id}`);
    return;
  }

  const id = crypto.randomUUID();
  stmtInsertItem.run({
    id,
    text,
    checked: 0,
    addedBy: username,
    checkedBy: null,
    listType,
    createdAt: timestamp,
    checkedAt: null,
  });
  console.log(`  Added item ${id}: "${text}" (${listType})`);
}

function handleCheck(action) {
  const { itemId, text, timestamp, username } = action;
  const item = findItem(itemId, text);

  if (item) {
    if (!item.checkedAt || timestamp >= item.checkedAt) {
      stmtUpdateItemCheck.run(username, timestamp, item.id);
      console.log(`  Checked item ${item.id}: "${item.text}" by ${username}`);
    } else {
      console.log(`  CHECK skipped (older timestamp) for "${item.text}"`);
    }
  } else {
    console.warn(`  CHECK failed — no matching item for id=${itemId} text="${text}"`);
  }
}

function handleUncheck(action) {
  const { itemId, text, timestamp } = action;
  const item = findItem(itemId, text);

  if (item) {
    if (!item.checkedAt || timestamp >= item.checkedAt) {
      stmtUpdateItemUncheck.run(timestamp, item.id);
      console.log(`  Unchecked item ${item.id}: "${item.text}"`);
    } else {
      console.log(`  UNCHECK skipped (older timestamp) for "${item.text}"`);
    }
  } else {
    console.warn(`  UNCHECK failed — no matching item for id=${itemId} text="${text}"`);
  }
}

function handleDelete(action) {
  const { itemId, text, username } = action;
  const item = findItem(itemId, text);

  if (item) {
    addTombstone(item.text, item.listType);
    stmtDeleteItem.run(item.id);
    console.log(`  Deleted item ${item.id}: "${item.text}" by ${username}`);
  } else {
    console.warn(`  DELETE failed — no matching item for id=${itemId} text="${text}"`);
  }
}

function clearChecked(listType, username) {
  const items = stmtGetCheckedItemsByListType.all(listType);
  let cleared = 0;

  // Use a transaction for bulk delete
  const transaction = db.transaction((itemsToDelete) => {
    for (const item of itemsToDelete) {
      addTombstone(item.text, item.listType);
      stmtDeleteItem.run(item.id);
      cleared++;
    }
  });

  transaction(items);
  console.log(`  [Clear] ${username} cleared ${cleared} checked items from "${listType}"`);
}

module.exports = {
  addTombstone,
  isTombstoned,
  cleanupTombstones,
  getAllItems,
  findItem,
  handleAdd,
  handleCheck,
  handleUncheck,
  handleDelete,
  clearChecked
};
