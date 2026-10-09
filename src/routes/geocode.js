import { Router } from 'express';
import { decode, extract, isFull, isShort, recoverNearest } from '../pluscode.js';
import { clusterNodes, parseIntersection, streetToken } from '../intersection.js';
import { findIntersectionNodes, toAreaId } from '../overpass.js';

const router = Router();

const NOMINATIM = 'https://nominatim.openstreetmap.org';
// Nominatim's usage policy requires an identifying User-Agent and max 1 req/sec.
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
  ?? 'MapPointer/1.0 (self-hosted demo; https://github.com/)';
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
let lastCall = 0;
let queue = Promise.resolve();

// Queue outbound calls so we never exceed one request per second.
function throttled(fn) {
  const next = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = next.catch(() => {});
  return next;
}

async function nominatim(pathname, params) {
  const url = new URL(pathname, NOMINATIM);
  url.search = new URLSearchParams({ format: 'jsonv2', ...params }).toString();

  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

  const body = await throttled(async () => {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const err = new Error(`Nominatim responded ${response.status}`);
      err.status = 502;
      throw err;
    }
    return response.json();
  });

  cache.set(cacheKey, { at: Date.now(), body });
  return body;
}

function mapPlace(place) {
  return {
    label: place.display_name,
    lat: Number(place.lat),
    lng: Number(place.lon),
    type: place.type,
    category: place.category ?? place.class,
    boundingbox: place.boundingbox?.map(Number),
  };
}

/**
 * Turns a decoded Plus Code area into a search result.
 */
function plusCodeResult(fullCode, area, label) {
  return {
    label,
    lat: area.lat,
    lng: area.lng,
    type: 'plus_code',
    category: 'plus_code',
    // Nominatim order: [south, north, west, east].
    boundingbox: [area.latLo, area.latHi, area.lngLo, area.lngHi],
    plusCode: fullCode,
    precisionMeters: area.precisionMeters,
  };
}

/**
 * Finds a reference coordinate for a short Plus Code: the locality text that
 * came with it, or failing that the caller's current map centre.
 */
async function findReference(localityText, query) {
  if (localityText) {
    const matches = await nominatim('/search', { q: localityText, limit: '1' });
    if (Array.isArray(matches) && matches.length > 0) {
      return {
        lat: Number(matches[0].lat),
        lng: Number(matches[0].lon),
        label: matches[0].display_name,
        from: 'locality',
      };
    }
  }

  const lat = Number(query.lat);
  const lng = Number(query.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, label: null, from: 'map' };
  }

  return null;
}

/**
 * Resolves a Plus Code (full or short) to a coordinate without hitting
 * Nominatim for the code itself - a Plus Code is already a coordinate.
 */
async function resolvePlusCode({ code, rest }, query) {
  if (isFull(code)) {
    const area = decode(code);

    // Give the pin a human-readable name where we can.
    let place = rest || null;
    if (!place) {
      try {
        const reverse = await nominatim('/reverse', { lat: String(area.lat), lon: String(area.lng) });
        place = reverse?.display_name ?? null;
      } catch {
        /* a label is nice to have, not required */
      }
    }

    return {
      results: [plusCodeResult(code, area, place ? `${code} (${place})` : code)],
    };
  }

  // Short codes only make sense relative to somewhere.
  const reference = await findReference(rest, query);
  if (!reference) {
    return {
      results: [],
      error: `"${code}" is a short Plus Code, so it needs a nearby place to resolve against. `
        + `Try including the town or city, for example "${code}, Cebu City".`,
    };
  }

  const fullCode = recoverNearest(code, reference.lat, reference.lng);
  const area = decode(fullCode);
  const place = rest || reference.label;

  return {
    results: [plusCodeResult(fullCode, area, place ? `${fullCode} (${place})` : fullCode)],
    note: `Resolved short Plus Code "${code}" to "${fullCode}" using `
      + (reference.from === 'locality' ? `"${rest}" as the reference.` : 'the current map view as the reference.'),
  };
}

/** Only boundaries and places have a usable extent to search inside. */
const AREA_CATEGORIES = new Set(['boundary', 'place']);

/**
 * "Cebu City, Cebu" -> ["Cebu City, Cebu", "Cebu City"].
 *
 * Trailing components are dropped progressively because Nominatim often ranks
 * an unrelated landmark above the city when the province is appended.
 */
function localityCandidates(text, max = 3) {
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  const candidates = [];
  for (let end = parts.length; end >= 1; end -= 1) {
    candidates.push(parts.slice(0, end).join(', '));
  }
  return [...new Set(candidates)].slice(0, max);
}

/** First result that is an actual area, ignoring landmarks of the same name. */
function pickArea(results) {
  if (!Array.isArray(results)) return null;

  for (const place of results) {
    if (!AREA_CATEGORIES.has(place.category ?? place.class)) continue;
    const id = toAreaId(place.osm_type, place.osm_id);
    if (id) return { id, label: place.display_name };
  }
  return null;
}

/**
 * Finds the OSM area to search inside: the locality the user typed, or
 * failing that whichever place the caller's map is centred on.
 */
async function resolveArea(localityText, query) {
  for (const candidate of localityText ? localityCandidates(localityText) : []) {
    const area = pickArea(await nominatim('/search', { q: candidate, limit: '5' }));
    if (area) return { ...area, from: 'locality' };
  }

  const lat = Number(query.lat);
  const lng = Number(query.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    // zoom=10 asks for the enclosing city rather than the nearest building.
    const place = await nominatim('/reverse', { lat: String(lat), lon: String(lng), zoom: '10' });
    const areaId = place ? toAreaId(place.osm_type, place.osm_id) : null;
    if (areaId) return { id: areaId, label: place.display_name, from: 'map' };
  }

  return null;
}

/**
 * Resolves "A corner B, City" to the actual junction(s) of the two streets.
 *
 * Returns `null` when the corner cannot be found, so the caller can fall back
 * to an ordinary search rather than showing nothing.
 */
async function resolveIntersection(parsed, query) {
  const tokenA = streetToken(parsed.streetA);
  const tokenB = streetToken(parsed.streetB);
  if (!tokenA || !tokenB || tokenA === tokenB) return null;

  const area = await resolveArea(parsed.locality, query);
  if (!area) {
    // With no locality text and no map position there is nothing to go on, and
    // saying so is more useful than a silent empty list.
    if (!parsed.locality) {
      return {
        error: `Could not work out which town "${parsed.streetA}" and "${parsed.streetB}" are in. `
          + 'Add a city to the query, for example '
          + `"${parsed.streetA} corner ${parsed.streetB}, Cebu City".`,
      };
    }
    // The locality was given but is not a mappable area - let the caller fall
    // back to an ordinary search.
    return null;
  }

  // Overpass is a free shared service and is often busy. Losing the corner
  // lookup should degrade to an ordinary search, not fail the request.
  let nodes;
  try {
    nodes = await findIntersectionNodes(area.id, tokenA, tokenB);
  } catch (err) {
    return { unavailable: err.expose ? err.message : 'The OpenStreetMap Overpass service is unavailable.' };
  }

  if (nodes.length === 0) return null;

  const clusters = clusterNodes(nodes);
  const where = parsed.locality || area.label?.split(',')[0] || '';

  return {
    results: clusters.map((cluster) => {
      const junction = cluster.members.find((node) => node.tags.highway)?.tags.highway;
      return {
        label: `${parsed.streetA} & ${parsed.streetB}${where ? `, ${where}` : ''}`
          + (junction ? ` (${junction.replace(/_/g, ' ')})` : ''),
        lat: cluster.lat,
        lng: cluster.lng,
        type: 'intersection',
        category: 'intersection',
        streets: [parsed.streetA, parsed.streetB],
        nodeCount: cluster.members.length,
      };
    }),
    note: clusters.length > 1
      ? `${parsed.streetA} and ${parsed.streetB} meet in ${clusters.length} places.`
      : undefined,
  };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/geocode/search?q=... -> place suggestions, Plus Codes included.
// Optional lat/lng narrow short Plus Codes to the caller's current map view.
router.get('/search', asyncRoute(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Query "q" must be at least 2 characters.' });

  // Plus Codes are coordinates, not names - resolve them locally first.
  const plus = extract(q);
  if (plus && (isFull(plus.code) || isShort(plus.code))) {
    const { results, note, error } = await resolvePlusCode(plus, req.query);
    if (error) return res.status(422).json({ error, query: q });
    return res.json({ query: q, results, ...(note ? { note } : {}) });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 10);

  // "A corner B" is an intersection, which Nominatim cannot answer.
  const corner = parseIntersection(q);
  if (corner) {
    const outcome = await resolveIntersection(corner, req.query);
    if (outcome?.error) return res.status(422).json({ error: outcome.error, query: q });
    if (outcome?.results?.length) {
      return res.json({ query: q, results: outcome.results, ...(outcome.note ? { note: outcome.note } : {}) });
    }

    // Either no shared node exists or Overpass was unavailable. Fall back to
    // the first street so the user gets somewhere useful, not an empty list.
    const fallbackQuery = [corner.streetA, corner.locality].filter(Boolean).join(', ');
    const fallback = await nominatim('/search', { q: fallbackQuery, limit: String(limit), addressdetails: '1' });

    return res.json({
      query: q,
      results: (Array.isArray(fallback) ? fallback : []).map(mapPlace),
      note: (outcome?.unavailable
        ?? `Could not find where "${corner.streetA}" and "${corner.streetB}" cross in OpenStreetMap.`)
        + ` Showing matches for "${fallbackQuery}" instead.`,
    });
  }

  const results = await nominatim('/search', { q, limit: String(limit), addressdetails: '1' });

  res.json({
    query: q,
    results: (Array.isArray(results) ? results : []).map(mapPlace),
  });
}));

// GET /api/geocode/reverse?lat=..&lng=.. -> address for a clicked point
router.get('/reverse', asyncRoute(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Valid "lat" and "lng" query params are required.' });
  }

  const result = await nominatim('/reverse', { lat: String(lat), lon: String(lng) });
  res.json({
    label: result?.display_name ?? null,
    name: result?.name || result?.address?.road || result?.address?.suburb || null,
    address: result?.address ?? null,
  });
}));

export default router;
