/**
 * Minimal Overpass API client.
 *
 * Overpass is a shared, free service, so calls are serialized, spaced out and
 * cached. Queries are built from tokens that are validated as plain
 * alphanumerics before interpolation.
 */

const ENDPOINT = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
  ?? 'MapPointer/1.0 (self-hosted demo; https://github.com/)';
const MIN_INTERVAL_MS = 2000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 40_000;

const cache = new Map();
let lastCall = 0;
let queue = Promise.resolve();

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

async function run(query) {
  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

  const body = await throttled(async () => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // 429/504 are Overpass saying "busy", which is worth distinguishing.
      const err = new Error(
        response.status === 429 || response.status === 504
          ? 'The OpenStreetMap Overpass service is busy. Try again in a moment.'
          : `Overpass responded ${response.status}`,
      );
      err.status = response.status === 429 || response.status === 504 ? 503 : 502;
      // This message is useful to the user, so let it through the handler.
      err.expose = true;
      throw err;
    }
    return response.json();
  });

  cache.set(query, { at: Date.now(), body });
  return body;
}

/**
 * Converts a Nominatim result into an Overpass area id. Only relations and
 * ways can be areas; a node has no extent.
 */
export function toAreaId(osmType, osmId) {
  const id = Number(osmId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (osmType === 'relation') return 3_600_000_000 + id;
  if (osmType === 'way') return 2_400_000_000 + id;
  return null;
}

/**
 * Finds the nodes shared by two named streets inside an area - the corners
 * where they meet.
 *
 * Restricting by area first is what makes this fast; bbox and `around`
 * variants of the same query time out on the public instance.
 */
export async function findIntersectionNodes(areaId, tokenA, tokenB) {
  // Tokens are interpolated into the query, so accept only plain words.
  for (const token of [tokenA, tokenB]) {
    if (!/^[a-z0-9]{2,40}$/i.test(token)) throw new Error(`Unsafe street token: ${token}`);
  }
  if (!Number.isInteger(areaId)) throw new Error('Invalid area id.');

  const query = `[out:json][timeout:25];
area(${areaId})->.searchArea;
way(area.searchArea)[highway][name~"${tokenA}",i]->.streetA;
way(area.searchArea)[highway][name~"${tokenB}",i]->.streetB;
node(w.streetA)->.nodesA;
node(w.streetB)->.nodesB;
node.nodesA.nodesB;
out tags geom;`;

  const body = await run(query);

  return (body.elements ?? [])
    .filter((element) => element.type === 'node'
      && Number.isFinite(element.lat) && Number.isFinite(element.lon))
    .map((element) => ({
      id: element.id,
      lat: element.lat,
      lng: element.lon,
      tags: element.tags ?? {},
    }));
}
