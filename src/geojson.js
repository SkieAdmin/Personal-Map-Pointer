/**
 * GeoJSON import/export for pins.
 *
 * Export is a plain FeatureCollection of Points, so the files also open in
 * geojson.io, QGIS, GitHub and Google Earth. Import is deliberately forgiving:
 * it takes what this app exports, what those tools export, and the raw marker
 * array the API itself returns.
 */

import { COLORS } from './validate.js';

/** Palette hexes, kept in step with the swatches in public/js/app.js. */
const COLOR_HEX = {
  blue: '#2f81f7',
  red: '#f85149',
  green: '#3fb950',
  orange: '#f0883e',
  purple: '#a371f7',
  gray: '#8b98a5',
};

// Property aliases other tools use.
const TITLE_KEYS = ['title', 'name', 'Name', 'label', 'NAME'];
const DESCRIPTION_KEYS = ['description', 'desc', 'notes', 'comment', 'Description'];
const COLOR_KEYS = ['color', 'colour', 'marker-color', 'markerColor'];

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** Maps an arbitrary hex colour onto the nearest palette entry. */
function nearestColor(hex) {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return null;

  const raw = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1];

  const target = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));

  let best = null;
  let bestDistance = Infinity;
  for (const [name, value] of Object.entries(COLOR_HEX)) {
    const rgb = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const distance = rgb.reduce((sum, channel, i) => sum + (channel - target[i]) ** 2, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

function normalizeColor(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  const lower = value.trim().toLowerCase();
  if (COLORS.includes(lower)) return lower;
  if (lower === 'grey') return 'gray';

  return nearestColor(lower) ?? undefined;
}

/**
 * Pulls [lng, lat] out of a GeoJSON position, which may carry an altitude.
 * Note the order: GeoJSON is longitude first.
 */
function fromPosition(position) {
  if (!Array.isArray(position) || position.length < 2) return null;

  const lng = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}

/** Finds the representative point of a geometry, if it has one. */
function pointOf(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;

  if (geometry.type === 'Point') return fromPosition(geometry.coordinates);

  // A single-point MultiPoint is unambiguous; anything larger is not a pin.
  if (geometry.type === 'MultiPoint' && geometry.coordinates?.length === 1) {
    return fromPosition(geometry.coordinates[0]);
  }
  return null;
}

function markerFromFeature(feature, index) {
  const properties = feature?.properties ?? {};
  const point = pointOf(feature?.geometry ?? feature);
  if (!point) return null;

  return {
    title: firstString(properties, TITLE_KEYS) || `Imported pin ${index + 1}`,
    description: firstString(properties, DESCRIPTION_KEYS),
    lat: point.lat,
    lng: point.lng,
    color: normalizeColor(firstString(properties, COLOR_KEYS)) ?? 'blue',
  };
}

/** A marker object as this API returns it, rather than a GeoJSON feature. */
function markerFromPlain(item, index) {
  if (!item || typeof item !== 'object') return null;

  const lat = Number(item.lat ?? item.latitude);
  const lng = Number(item.lng ?? item.lon ?? item.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    title: firstString(item, TITLE_KEYS) || `Imported pin ${index + 1}`,
    description: firstString(item, DESCRIPTION_KEYS),
    lat,
    lng,
    color: normalizeColor(firstString(item, COLOR_KEYS)) ?? 'blue',
  };
}

/**
 * Collects the feature-like entries out of any accepted input shape.
 */
function candidatesOf(input) {
  if (Array.isArray(input)) return { items: input, plain: !input.some((i) => i?.type === 'Feature') };

  if (input && typeof input === 'object') {
    if (Array.isArray(input.features)) return { items: input.features, plain: false };
    if (Array.isArray(input.markers)) return { items: input.markers, plain: true };
    if (input.type === 'Feature' || input.type === 'Point' || input.type === 'MultiPoint') {
      return { items: [input], plain: false };
    }
    if (input.type === 'GeometryCollection' && Array.isArray(input.geometries)) {
      return { items: input.geometries, plain: false };
    }
  }
  return null;
}

/**
 * Parses GeoJSON (or a marker array) into marker input.
 *
 * @param {unknown} input already-parsed JSON
 * @returns {{ markers: object[], skipped: number }}
 * @throws {Error} when the input is not a shape we recognise at all
 */
export function fromGeoJSON(input) {
  const found = candidatesOf(input);
  if (!found) {
    throw new Error(
      'Unrecognised file. Expected GeoJSON (a FeatureCollection of Points) or an array of markers.',
    );
  }

  const markers = [];
  let skipped = 0;

  found.items.forEach((item, index) => {
    const marker = found.plain
      ? markerFromPlain(item, index)
      : markerFromFeature(item, index);

    // Lines, polygons and malformed entries are counted, not silently dropped.
    if (marker) markers.push(marker);
    else skipped += 1;
  });

  return { markers, skipped };
}

/**
 * Builds the FeatureCollection written by Export.
 */
export function toGeoJSON(markers) {
  return {
    type: 'FeatureCollection',
    features: markers.map((marker) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [marker.lng, marker.lat] },
      properties: {
        title: marker.title,
        description: marker.description,
        color: marker.color,
        // simplestyle, so the colour survives a trip through other tools.
        'marker-color': COLOR_HEX[marker.color] ?? COLOR_HEX.blue,
        createdAt: marker.createdAt,
      },
    })),
  };
}
