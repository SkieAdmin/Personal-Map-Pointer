/**
 * Pin storage, backed by SQLite through Node's built-in `node:sqlite`.
 *
 * Every write commits immediately, so pins are saved as soon as they are made -
 * there is no flush step to lose. WAL mode keeps the database intact if the
 * process is killed mid-write, which a plain JSON file could not promise.
 *
 * The methods are async even though SQLite here is synchronous, so that callers
 * (and a future swap to a networked database) need not change.
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = process.env.MAP_POINTER_DB ?? path.join(DATA_DIR, 'map-pointer.db');
const LEGACY_JSON = path.join(DATA_DIR, 'markers.json');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

// WAL survives an abrupt exit and lets reads continue during a write.
db.exec('PRAGMA journal_mode = WAL');
// NORMAL is crash-safe under WAL; FULL only adds protection against power loss.
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS markers (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    color       TEXT NOT NULL DEFAULT 'blue',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS markers_created_at ON markers (created_at);
`);

const statements = {
  // rowid is insertion order. created_at only has millisecond resolution, so
  // pins made in the same millisecond would otherwise come back in any order.
  all: db.prepare('SELECT * FROM markers ORDER BY rowid'),
  byId: db.prepare('SELECT * FROM markers WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO markers (id, title, description, lat, lng, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE markers
       SET title = ?, description = ?, lat = ?, lng = ?, color = ?, updated_at = ?
     WHERE id = ?
  `),
  remove: db.prepare('DELETE FROM markers WHERE id = ?'),
  removeAll: db.prepare('DELETE FROM markers'),
  count: db.prepare('SELECT COUNT(*) AS n FROM markers'),
};

/** SQLite columns are snake_case; the API has always spoken camelCase. */
function toMarker(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    lat: row.lat,
    lng: row.lng,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insert(data, now = new Date().toISOString()) {
  const marker = {
    id: randomUUID(),
    title: data.title,
    description: data.description ?? '',
    lat: data.lat,
    lng: data.lng,
    color: data.color ?? 'blue',
    createdAt: now,
    updatedAt: now,
  };

  statements.insert.run(
    marker.id, marker.title, marker.description,
    marker.lat, marker.lng, marker.color,
    marker.createdAt, marker.updatedAt,
  );

  return marker;
}

/** Runs `fn` in a transaction, rolling back if it throws. */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Moves pins from the old data/markers.json into SQLite the first time this
 * runs, so an existing map is not lost. The file is kept, renamed, rather than
 * deleted.
 */
function migrateLegacyJson() {
  if (statements.count.get().n > 0) return null;
  if (!fs.existsSync(LEGACY_JSON)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
  } catch {
    return null;
  }

  const pins = Array.isArray(parsed) ? parsed : [];
  const usable = pins.filter((pin) => (
    pin && typeof pin.title === 'string'
    && Number.isFinite(Number(pin.lat)) && Number.isFinite(Number(pin.lng))
  ));

  if (usable.length === 0) return null;

  transaction(() => {
    for (const pin of usable) {
      const now = new Date().toISOString();
      statements.insert.run(
        typeof pin.id === 'string' && pin.id ? pin.id : randomUUID(),
        pin.title,
        typeof pin.description === 'string' ? pin.description : '',
        Number(pin.lat),
        Number(pin.lng),
        typeof pin.color === 'string' ? pin.color : 'blue',
        typeof pin.createdAt === 'string' ? pin.createdAt : now,
        typeof pin.updatedAt === 'string' ? pin.updatedAt : now,
      );
    }
  });

  const archived = `${LEGACY_JSON}.migrated`;
  try {
    fs.renameSync(LEGACY_JSON, archived);
  } catch {
    /* the pins are already safe in SQLite; keeping the file is only tidiness */
  }

  return { count: usable.length, archived };
}

export const migration = migrateLegacyJson();
export const databaseFile = DB_FILE;

export const store = {
  async list() {
    return statements.all.all().map(toMarker);
  },

  async get(id) {
    const row = statements.byId.get(id);
    return row ? toMarker(row) : null;
  },

  async create(data) {
    return insert(data);
  },

  async update(id, data) {
    const existing = statements.byId.get(id);
    if (!existing) return null;

    const merged = { ...toMarker(existing), ...data };
    const updatedAt = new Date().toISOString();

    statements.update.run(
      merged.title, merged.description, merged.lat, merged.lng, merged.color,
      updatedAt, id,
    );

    return { ...merged, id, createdAt: existing.created_at, updatedAt };
  },

  async remove(id) {
    return statements.remove.run(id).changes > 0;
  },

  async clear() {
    return statements.removeAll.run().changes;
  },

  async replaceAll(incoming) {
    // One transaction, so an import never leaves a half-written map.
    return transaction(() => {
      statements.removeAll.run();
      const now = new Date().toISOString();
      return incoming.map((data) => insert(data, now));
    });
  },
};

/** Closes the database. Used on shutdown so WAL is checkpointed cleanly. */
export function closeStore() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* already closed */
  }
}
