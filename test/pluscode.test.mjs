/**
 * Runs src/pluscode.js against the official Open Location Code test vectors
 * in test/data/ (see that folder's README for provenance).
 *
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encode, decode, isValid, isFull, isShort, recoverNearest, shorten, extract,
} from '../src/pluscode.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

function rows(file) {
  return fs.readFileSync(path.join(dataDir, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(','));
}

// Decoded values are compared with a tolerance, since the deepest codes sit at
// the edge of double precision.
const close = (got, want, tol, label) => {
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tol ${tol})`);
};

test('encode matches official encoding.csv', () => {
  const cases = rows('encoding.csv');
  assert.ok(cases.length > 290, 'expected the full vector set');

  for (const [lat, lng, , , length, expected] of cases) {
    assert.equal(
      encode(Number(lat), Number(lng), Number(length)),
      expected,
      `encode(${lat}, ${lng}, ${length})`,
    );
  }
});

test('decode matches official decoding.csv', () => {
  const cases = rows('decoding.csv');
  assert.ok(cases.length > 400, 'expected the full vector set');

  for (const [code, length, latLo, lngLo, latHi, lngHi] of cases) {
    const area = decode(code);
    assert.equal(area.codeLength, Number(length), `${code} length`);
    close(area.latLo, Number(latLo), 1e-10, `${code} latLo`);
    close(area.lngLo, Number(lngLo), 1e-10, `${code} lngLo`);
    close(area.latHi, Number(latHi), 1e-10, `${code} latHi`);
    close(area.lngHi, Number(lngHi), 1e-10, `${code} lngHi`);
  }
});

test('validity matches official validityTests.csv', () => {
  const cases = rows('validityTests.csv');
  assert.ok(cases.length > 20, 'expected the full vector set');

  for (const [code, valid, short, full] of cases) {
    assert.equal(isValid(code), valid === 'true', `isValid(${code})`);
    assert.equal(isShort(code), short === 'true', `isShort(${code})`);
    assert.equal(isFull(code), full === 'true', `isFull(${code})`);
  }
});

test('shorten and recoverNearest match official shortCodeTests.csv', () => {
  const cases = rows('shortCodeTests.csv');
  assert.ok(cases.length > 15, 'expected the full vector set');

  for (const [code, lat, lng, shortCode, type] of cases) {
    const kind = (type ?? 'B').trim();

    // "S" = shorten only, "R" = recover only, "B" = both directions.
    if (kind === 'B' || kind === 'S') {
      assert.equal(shorten(code, Number(lat), Number(lng)), shortCode, `shorten(${code})`);
    }
    if (kind === 'B' || kind === 'R') {
      assert.equal(
        recoverNearest(shortCode, Number(lat), Number(lng)),
        code,
        `recoverNearest(${shortCode}, ${lat}, ${lng})`,
      );
    }
  }
});

test('extract pulls a Plus Code out of a free-form query', () => {
  assert.deepEqual(
    extract('8W66+RV9, H. Joaquino St, Cebu City, 6000 Cebu'),
    { code: '8W66+RV9', rest: 'H. Joaquino St, Cebu City, 6000 Cebu' },
  );

  assert.deepEqual(
    extract('7FG49QCJ+2V'),
    { code: '7FG49QCJ+2V', rest: '' },
  );

  // Lowercase input is accepted and normalised.
  assert.equal(extract('cebu city 8w66+rv9')?.code, '8W66+RV9');

  // Plain addresses must not be mistaken for codes.
  assert.equal(extract('H. Joaquino St, Cebu City'), null);
  assert.equal(extract('Cebu City, 6000 Cebu'), null);
  assert.equal(extract(''), null);
});

test('the reported Cebu City code resolves into Cebu', () => {
  // Reference point: H. Joaquino Street, Cebu City, as returned by Nominatim.
  const full = recoverNearest('8W66+RV9', 10.3138034, 123.9116616);
  const area = decode(full);

  assert.ok(isFull(full), `${full} should be a full code`);

  // Must land inside Cebu City, not on the other side of the planet.
  close(area.lat, 10.31, 0.05, 'Cebu latitude');
  close(area.lng, 123.91, 0.05, 'Cebu longitude');
});
