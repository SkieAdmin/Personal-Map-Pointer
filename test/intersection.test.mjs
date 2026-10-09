/**
 * Parsing of intersection queries ("A corner B, City"). Pure functions only -
 * no network, so these run offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIntersection, streetToken, clusterNodes, distanceMeters,
} from '../src/intersection.js';
import { toAreaId } from '../src/overpass.js';

test('recognises the common ways people write a corner', () => {
  const expected = { streetA: 'N.Bacalso Ave', streetB: 'V Rama Ave', locality: 'Cebu City, Cebu' };

  // The form the user actually typed, with a comma before "Corner".
  assert.deepEqual(
    parseIntersection('N.Bacalso Ave, Corner V Rama Ave, Cebu City, Cebu'),
    expected,
  );

  for (const [query, streetA, streetB, locality] of [
    ['N. Bacalso Ave & V. Rama Ave, Cebu City', 'N. Bacalso Ave', 'V. Rama Ave', 'Cebu City'],
    ['Bacalso Ave cor. Rama Ave, Cebu City', 'Bacalso Ave', 'Rama Ave', 'Cebu City'],
    ['Bacalso / Rama, Cebu City', 'Bacalso', 'Rama', 'Cebu City'],
    ['corner of Bacalso and Rama, Cebu City', 'Bacalso', 'Rama', 'Cebu City'],
    ['A Street corner B Street', 'A Street', 'B Street', ''],
  ]) {
    assert.deepEqual(parseIntersection(query), { streetA, streetB, locality }, query);
  }
});

test('leaves ordinary queries alone', () => {
  for (const query of [
    'H. Joaquino St, Cebu City',
    '8W66+RV9, Cebu City',
    'Cebu City',
    'Eiffel Tower, Paris',
    '',
    'corner',           // marker with nothing either side
    'Corner Street',    // a street literally named "Corner"
  ]) {
    assert.equal(parseIntersection(query), null, query);
  }

  assert.equal(parseIntersection(null), null);
  assert.equal(parseIntersection(undefined), null);
});

test('reduces street names to the word OSM is likely to hold', () => {
  // Initials and street types are noise; the distinctive word is what matches.
  assert.equal(streetToken('N.Bacalso Ave'), 'bacalso');
  assert.equal(streetToken('V Rama Ave'), 'rama');
  assert.equal(streetToken('N. Bacalso Avenue'), 'bacalso');
  assert.equal(streetToken('Natalio B. Bacalso Avenue'), 'bacalso');
  assert.equal(streetToken('H. Joaquino Street'), 'joaquino');

  // Nothing distinctive to go on.
  assert.equal(streetToken('Ave'), null);
  assert.equal(streetToken('N. S.'), null);
  assert.equal(streetToken(''), null);
  assert.equal(streetToken(42), null);

  // Tokens are interpolated into an Overpass query, so they must stay plain.
  for (const name of ['Rama"; out; //', "O'Brien Rd", 'Foo[bar]']) {
    const token = streetToken(name);
    if (token !== null) assert.match(token, /^[a-z0-9]+$/, name);
  }
});

test('groups the nodes of one junction into a single place', () => {
  // The real N. Bacalso x V. Rama junction: two carriageways, ~13 m apart.
  const a = { lat: 10.2971906, lng: 123.8883546, tags: { highway: 'traffic_signals' } };
  const b = { lat: 10.2972777, lng: 123.8882788, tags: { highway: 'traffic_signals' } };

  assert.ok(Math.round(distanceMeters(a, b)) < 20);

  const [cluster, ...rest] = clusterNodes([a, b]);
  assert.equal(rest.length, 0, 'should collapse to one cluster');
  assert.equal(cluster.members.length, 2);
  assert.ok(Math.abs(cluster.lat - 10.29723) < 1e-4);

  // Genuinely separate crossings stay separate.
  const far = { lat: 10.35, lng: 123.9, tags: {} };
  assert.equal(clusterNodes([a, b, far]).length, 2);
});

test('distanceMeters agrees with known distances', () => {
  // One degree of latitude is ~111 km.
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111_195) < 500);
  assert.equal(Math.round(distanceMeters({ lat: 10, lng: 123 }, { lat: 10, lng: 123 })), 0);
});

test('converts OSM ids to Overpass area ids', () => {
  assert.equal(toAreaId('relation', 12455830), 3_612_455_830);
  assert.equal(toAreaId('way', 226488304), 2_626_488_304);

  // A node has no extent, so it cannot be an area.
  assert.equal(toAreaId('node', 8628235960), null);
  assert.equal(toAreaId('relation', 0), null);
  assert.equal(toAreaId('relation', 'abc'), null);
});
