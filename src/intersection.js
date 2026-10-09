/**
 * Street-intersection queries ("A corner B, City").
 *
 * Nominatim has no concept of an intersection - it matches place names, so
 * "N.Bacalso Ave, Corner V Rama Ave" finds nothing even though both streets
 * are in OSM. Overpass can answer it directly by asking for the nodes that two
 * named ways share, which is exactly what a street corner is.
 */

/** "corner of A and B" - the streets follow the marker, joined by and/&//. */
const CORNER_OF = /\bcorner\s+of\b/i;
/** "A corner B", "A cor. B" - the marker sits between the two streets. */
const CORNER_BETWEEN = /\b(?:corner|crn\.?|cor\.?)(?=\s)/i;
/** "A & B", "A / B" */
const SYMBOL_BETWEEN = /\s[&/]\s/;
/** Separators valid after "corner of". */
const AFTER_CORNER_OF = /\s+and\s+|\s*[&/]\s*/i;

const STREET_TYPES = new Set([
  'ave', 'av', 'avenue', 'st', 'street', 'rd', 'road', 'blvd', 'boulevard',
  'hwy', 'highway', 'dr', 'drive', 'ln', 'lane', 'way', 'ext', 'extension',
  'circle', 'cir', 'pkwy', 'parkway', 'ter', 'terrace', 'pl', 'place',
  'sq', 'square', 'diversion', 'bypass',
]);

const DIRECTIONS = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western',
]);

const tidy = (text) => text.replace(/^[\s,]+|[\s,]+$/g, '').trim();

/** Splits "V Rama Ave, Cebu City, Cebu" into the street and the rest. */
function splitLocality(text) {
  const parts = tidy(text).split(',').map((part) => part.trim()).filter(Boolean);
  return { street: parts[0] ?? '', locality: parts.slice(1).join(', ') };
}

/**
 * Parses an intersection query.
 *
 * @returns {{ streetA: string, streetB: string, locality: string } | null}
 */
export function parseIntersection(query) {
  if (typeof query !== 'string') return null;

  // A comma right before the marker ("A, Corner B") is punctuation, not a split.
  const text = tidy(query).replace(/,\s*(?=(?:corner|cor\.?|crn\.?)\b)/i, ' ');
  if (!text) return null;

  let streetA = '';
  let tail = '';

  const cornerOf = text.match(CORNER_OF);
  if (cornerOf) {
    const after = text.slice(cornerOf.index + cornerOf[0].length);
    const separator = after.match(AFTER_CORNER_OF);
    if (!separator) return null;

    streetA = tidy(after.slice(0, separator.index));
    tail = after.slice(separator.index + separator[0].length);
  } else {
    const between = text.match(CORNER_BETWEEN) ?? text.match(SYMBOL_BETWEEN);
    if (!between) return null;

    streetA = tidy(text.slice(0, between.index));
    tail = text.slice(between.index + between[0].length);
  }

  const { street: streetB, locality } = splitLocality(tail);

  // Both sides must look like real names, or this was a false positive.
  if (streetA.length < 2 || streetB.length < 2) return null;

  return { streetA, streetB, locality };
}

/**
 * Reduces a street name to its most distinctive word, for matching against OSM
 * names. "N.Bacalso Ave" -> "bacalso", which matches "Natalio Bacalso Avenue".
 */
export function streetToken(name) {
  if (typeof name !== 'string') return null;

  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const significant = words.filter((word) => (
    word.length > 1
    && !STREET_TYPES.has(word)
    && !DIRECTIONS.has(word)
    && !/^\d+$/.test(word)
  ));

  if (significant.length === 0) return null;

  // Longest word wins; on a tie prefer the later one, since surnames trail
  // initials in names like "Natalio B. Bacalso".
  return significant.reduce((best, word) => (word.length >= best.length ? word : best));
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Groups nearby nodes into one place. A junction of two dual carriageways is
 * several OSM nodes a few metres apart, but it is one corner to a person.
 */
export function clusterNodes(nodes, radiusMeters = 80) {
  const clusters = [];

  for (const node of nodes) {
    const hit = clusters.find((cluster) => distanceMeters(cluster, node) <= radiusMeters);
    if (hit) {
      hit.members.push(node);
      // Recentre on the mean of the cluster's members.
      hit.lat = hit.members.reduce((sum, m) => sum + m.lat, 0) / hit.members.length;
      hit.lng = hit.members.reduce((sum, m) => sum + m.lng, 0) / hit.members.length;
    } else {
      clusters.push({ lat: node.lat, lng: node.lng, members: [node] });
    }
  }

  return clusters;
}
