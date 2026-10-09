/**
 * SQLite-backed store. Runs against a throwaway database file, so it never
 * touches data/map-pointer.db.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The store reads this when first imported, so it must be set before the
// dynamic import below.
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'map-pointer-')), 'test.db');
process.env.MAP_POINTER_DB = dbFile;

const { store, closeStore, databaseFile } = await import('../src/store.js');

test.after(() => {
  closeStore();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

const pin = (overrides = {}) => ({
  title: 'A pin', description: '', lat: 10.3, lng: 123.9, color: 'blue', ...overrides,
});

test('uses the database file it was pointed at', () => {
  assert.equal(databaseFile, dbFile);
  assert.ok(fs.existsSync(dbFile), 'database file should be created on import');
});

test('creates, reads, updates and deletes a pin', async () => {
  await store.clear();

  const created = await store.create(pin({ title: 'Cebu corner', color: 'orange' }));
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.title, 'Cebu corner');
  assert.equal(created.color, 'orange');
  assert.equal(created.createdAt, created.updatedAt);

  const fetched = await store.get(created.id);
  assert.deepEqual(fetched, created);

  // Coordinates must come back as numbers, not strings from the DB driver.
  assert.equal(typeof fetched.lat, 'number');
  assert.equal(typeof fetched.lng, 'number');

  const moved = await store.update(created.id, { lat: 10.5, lng: 123.5 });
  assert.equal(moved.lat, 10.5);
  assert.equal(moved.lng, 123.5);
  assert.equal(moved.title, 'Cebu corner', 'untouched fields should survive a partial update');
  assert.equal(moved.createdAt, created.createdAt, 'createdAt must not move');
  assert.notEqual(moved.updatedAt, created.updatedAt, 'updatedAt should advance');

  assert.equal(await store.remove(created.id), true);
  assert.equal(await store.get(created.id), null);
  assert.equal(await store.remove(created.id), false, 'removing twice is not an error');
});

test('reports a miss rather than throwing', async () => {
  assert.equal(await store.get(randomUUID()), null);
  assert.equal(await store.update(randomUUID(), { lat: 1 }), null);
  assert.equal(await store.remove(randomUUID()), false);
});

test('lists pins oldest first', async () => {
  await store.clear();

  await store.create(pin({ title: 'first' }));
  await store.create(pin({ title: 'second' }));
  await store.create(pin({ title: 'third' }));

  assert.deepEqual((await store.list()).map((m) => m.title), ['first', 'second', 'third']);
});

test('keeps every pin when writes overlap', async () => {
  await store.clear();

  // The previous JSON store needed a write queue to avoid lost updates; this
  // asserts the replacement does not reintroduce that bug.
  const count = 50;
  const created = await Promise.all(
    Array.from({ length: count }, (_, i) => store.create(pin({ title: `pin ${i}` }))),
  );

  const stored = await store.list();
  assert.equal(stored.length, count);
  assert.equal(new Set(created.map((m) => m.id)).size, count, 'ids must be unique');
  assert.deepEqual(
    new Set(stored.map((m) => m.title)),
    new Set(created.map((m) => m.title)),
  );
});

test('clear empties the table and reports how many went', async () => {
  await store.clear();
  await store.create(pin());
  await store.create(pin());

  assert.equal(await store.clear(), 2);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.clear(), 0);
});

test('replaceAll swaps the whole collection', async () => {
  await store.clear();
  const old = await store.create(pin({ title: 'to be replaced' }));

  const replaced = await store.replaceAll([
    pin({ title: 'new one' }),
    pin({ title: 'new two', color: 'green' }),
  ]);

  assert.equal(replaced.length, 2);
  assert.equal(await store.get(old.id), null, 'the old pin should be gone');

  const stored = await store.list();
  assert.deepEqual(stored.map((m) => m.title), ['new one', 'new two']);
  assert.equal(stored[1].color, 'green');

  // Replacing with nothing is a valid way to empty the map.
  assert.deepEqual(await store.replaceAll([]), []);
  assert.deepEqual(await store.list(), []);
});

test('a failed replaceAll leaves the previous pins untouched', async () => {
  await store.clear();
  await store.create(pin({ title: 'keep me' }));

  // A pin with a null title violates NOT NULL, so the transaction must roll back.
  await assert.rejects(() => store.replaceAll([pin({ title: 'fine' }), pin({ title: null })]));

  assert.deepEqual((await store.list()).map((m) => m.title), ['keep me']);
});

test('survives reopening the database', async () => {
  await store.clear();
  await store.create(pin({ title: 'persisted', lat: 10.2972341, lng: 123.8883167 }));

  // A second connection to the same file sees committed data, which is what a
  // restart does.
  const { DatabaseSync } = await import('node:sqlite');
  const other = new DatabaseSync(dbFile);
  const rows = other.prepare('SELECT title, lat, lng FROM markers').all();
  other.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'persisted');
  assert.equal(rows[0].lat, 10.2972341);
});
