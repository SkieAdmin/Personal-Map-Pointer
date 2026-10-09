/**
 * GeoJSON import/export. Offline - pure functions only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fromGeoJSON, toGeoJSON } from '../src/geojson.js';

const pins = [
  {
    id: 'a', title: 'Eiffel Tower', description: 'Paris landmark',
    lat: 48.8584, lng: 2.2945, color: 'red', createdAt: '2026-10-09T00:00:00.000Z',
  },
  {
    id: 'b', title: 'Cebu corner', description: '',
    lat: 10.2972341, lng: 123.8883167, color: 'orange', createdAt: '2026-10-09T00:00:01.000Z',
  },
];

test('export then import returns the same pins', () => {
  const { markers, skipped } = fromGeoJSON(toGeoJSON(pins));

  assert.equal(skipped, 0);
  assert.equal(markers.length, 2);

  markers.forEach((marker, i) => {
    assert.equal(marker.title, pins[i].title);
    assert.equal(marker.description, pins[i].description);
    assert.equal(marker.color, pins[i].color);
    // Coordinates must survive exactly, not just approximately.
    assert.equal(marker.lat, pins[i].lat);
    assert.equal(marker.lng, pins[i].lng);
  });
});

test('export writes GeoJSON longitude-first', () => {
  const [feature] = toGeoJSON([pins[0]]).features;

  assert.equal(feature.type, 'Feature');
  assert.equal(feature.geometry.type, 'Point');
  // [lng, lat] - getting this backwards is the classic GeoJSON bug.
  assert.deepEqual(feature.geometry.coordinates, [2.2945, 48.8584]);
  assert.equal(feature.properties['marker-color'], '#f85149');
});

test('import reads longitude-first coordinates', () => {
  const { markers } = fromGeoJSON({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { title: 'Somewhere' },
      geometry: { type: 'Point', coordinates: [123.8883167, 10.2972341] },
    }],
  });

  assert.equal(markers[0].lat, 10.2972341);
  assert.equal(markers[0].lng, 123.8883167);
});

test('accepts the property names other tools use', () => {
  const { markers } = fromGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'From name', desc: 'short desc' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: { Name: 'From Name', notes: 'a note' }, geometry: { type: 'Point', coordinates: [3, 4] } },
      { type: 'Feature', properties: { label: 'From label' }, geometry: { type: 'Point', coordinates: [5, 6] } },
    ],
  });

  assert.deepEqual(markers.map((m) => m.title), ['From name', 'From Name', 'From label']);
  assert.deepEqual(markers.map((m) => m.description), ['short desc', 'a note', '']);
});

test('maps arbitrary hex colours onto the palette', () => {
  const colourOf = (properties) => fromGeoJSON({
    type: 'Feature', properties, geometry: { type: 'Point', coordinates: [0, 0] },
  }).markers[0].color;

  assert.equal(colourOf({ color: 'green' }), 'green');
  assert.equal(colourOf({ colour: 'PURPLE' }), 'purple');
  assert.equal(colourOf({ color: 'grey' }), 'gray');

  // simplestyle hex, as geojson.io writes it.
  assert.equal(colourOf({ 'marker-color': '#f85149' }), 'red');
  assert.equal(colourOf({ 'marker-color': '#ff0000' }), 'red');
  assert.equal(colourOf({ 'marker-color': '#00ff00' }), 'green');
  assert.equal(colourOf({ 'marker-color': '#0f0' }), 'green');

  // Unusable values fall back rather than throwing.
  assert.equal(colourOf({ color: 'chartreuse' }), 'blue');
  assert.equal(colourOf({}), 'blue');
});

test('names untitled pins instead of rejecting them', () => {
  const { markers } = fromGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] } },
    ],
  });

  assert.deepEqual(markers.map((m) => m.title), ['Imported pin 1', 'Imported pin 2']);
});

test('counts features that are not pins', () => {
  const { markers, skipped } = fromGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { title: 'keep' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: { title: 'a road' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { type: 'Feature', properties: { title: 'an area' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { type: 'Feature', properties: { title: 'broken' }, geometry: { type: 'Point', coordinates: ['x', 'y'] } },
      null,
    ],
  });

  assert.deepEqual(markers.map((m) => m.title), ['keep']);
  assert.equal(skipped, 4);
});

test('accepts the other shapes a file might arrive in', () => {
  // A bare Feature.
  assert.equal(fromGeoJSON({
    type: 'Feature', properties: { title: 'Solo' }, geometry: { type: 'Point', coordinates: [1, 2] },
  }).markers.length, 1);

  // A bare geometry.
  assert.equal(fromGeoJSON({ type: 'Point', coordinates: [1, 2] }).markers.length, 1);

  // A single-point MultiPoint is unambiguous.
  assert.equal(fromGeoJSON({ type: 'MultiPoint', coordinates: [[1, 2]] }).markers.length, 1);

  // The raw marker array this API returns.
  const plain = fromGeoJSON([{ title: 'Plain', lat: 10, lng: 123, color: 'green' }]);
  assert.equal(plain.markers.length, 1);
  assert.deepEqual(
    [plain.markers[0].lat, plain.markers[0].lng, plain.markers[0].color],
    [10, 123, 'green'],
  );

  // And the {count, markers} envelope from GET /api/markers.
  assert.equal(fromGeoJSON({ count: 1, markers: [{ title: 'Env', lat: 1, lng: 2 }] }).markers.length, 1);
});

test('rejects input that is not a pin file at all', () => {
  for (const input of [null, undefined, 42, 'hello', true, { hello: 'world' }]) {
    assert.throws(() => fromGeoJSON(input), /Unrecognised file/, JSON.stringify(input));
  }

  // Structurally valid but empty.
  assert.deepEqual(
    fromGeoJSON({ type: 'FeatureCollection', features: [] }),
    { markers: [], skipped: 0 },
  );
});
