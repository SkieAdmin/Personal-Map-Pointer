/**
 * Open Location Code (Google "Plus Codes") encode/decode.
 *
 * Nominatim does not understand Plus Codes, so we resolve them locally - a Plus
 * Code is an encoded coordinate, not a name that needs looking up.
 *
 * Spec: https://github.com/google/open-location-code
 */

const ALPHABET = '23456789CFGHJMPQRVWX';
const SEPARATOR = '+';
const SEPARATOR_POSITION = 8;
const PADDING = '0';
const PAIR_CODE_LENGTH = 10;
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const LAT_MAX = 90;
const LNG_MAX = 180;
const MIN_TRIMMABLE_CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 15;
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];
const ENCODING_BASE = 20;
const GRID_CODE_LENGTH = MAX_CODE_LENGTH - PAIR_CODE_LENGTH;
const LAT_INTEGER_MULTIPLIER = 8000 * 3125;
const LNG_INTEGER_MULTIPLIER = 8000 * 1024;

/** Matches a full or short Plus Code token, e.g. "8FVC9G8F+6W" or "8W66+RV9". */
const CODE_PATTERN = /\b([23456789CFGHJMPQRVWX]{2,8}0*\+[23456789CFGHJMPQRVWX]{0,8})\b/i;

function clipLatitude(lat) {
  return Math.min(90, Math.max(-90, lat));
}

function normalizeLongitude(lng) {
  let value = lng;
  while (value < -180) value += 360;
  while (value >= 180) value -= 360;
  return value;
}

/** Shortest code length that still covers the given latitude band. */
function computeLatitudePrecision(codeLength) {
  if (codeLength <= 10) return 20 ** (Math.floor(codeLength / -2) + 2);
  return 20 ** -3 / GRID_ROWS ** (codeLength - 10);
}

/**
 * True when `code` is a syntactically valid Plus Code (full or short).
 */
export function isValid(code) {
  if (!code || typeof code !== 'string') return false;

  const separatorIndex = code.indexOf(SEPARATOR);
  if (separatorIndex === -1) return false;
  if (separatorIndex !== code.lastIndexOf(SEPARATOR)) return false;
  if (separatorIndex > SEPARATOR_POSITION || separatorIndex % 2 === 1) return false;

  // Padding, when present, must be a contiguous run ending at the separator.
  if (code.includes(PADDING)) {
    if (separatorIndex !== SEPARATOR_POSITION) return false;
    if (code.indexOf(PADDING) % 2 === 1) return false;

    const padding = code.slice(code.indexOf(PADDING), separatorIndex);
    if (padding !== PADDING.repeat(padding.length)) return false;
    // Nothing may follow the separator once padded.
    if (!code.endsWith(SEPARATOR)) return false;
  }

  // A code may have at most one character after the separator... or two or more.
  const after = code.slice(separatorIndex + 1);
  if (after.length === 1) return false;

  const body = code.replace(SEPARATOR, '').replace(new RegExp(`${PADDING}+`, 'g'), '');
  if (body.length < 2) return false;

  for (const char of body.toUpperCase()) {
    if (!ALPHABET.includes(char)) return false;
  }
  return true;
}

/** A full code has 8 characters before the separator. */
export function isFull(code) {
  if (!isValid(code)) return false;
  if (code.indexOf(SEPARATOR) !== SEPARATOR_POSITION) return false;

  // First character limits latitude to +/-90, second limits longitude to +/-180.
  const first = ALPHABET.indexOf(code[0].toUpperCase());
  if (first * 20 >= LAT_MAX * 2) return false;

  const second = ALPHABET.indexOf(code[1].toUpperCase());
  return second * 20 < LNG_MAX * 2;
}

/** A short code has had 2, 4, 6 or 8 leading characters removed. */
export function isShort(code) {
  return isValid(code) && code.indexOf(SEPARATOR) < SEPARATOR_POSITION;
}

/**
 * Encodes a coordinate into a Plus Code.
 */
export function encode(latitude, longitude, codeLength = PAIR_CODE_LENGTH) {
  let length = codeLength;
  if (length < 2) throw new Error('Code length must be at least 2.');
  if (length < PAIR_CODE_LENGTH && length % 2 === 1) length += 1;
  length = Math.min(length, MAX_CODE_LENGTH);

  let lat = clipLatitude(latitude);
  const lng = normalizeLongitude(longitude);

  // Keep the exact north pole inside the last valid cell.
  if (lat === 90) lat -= computeLatitudePrecision(length);

  // Scale to integers before splitting into digits. Accumulating with floating
  // point drifts at the deeper grid levels and produces wrong codes.
  let latValue = Math.floor(Math.round((lat + LAT_MAX) * LAT_INTEGER_MULTIPLIER * 1e6) / 1e6);
  let lngValue = Math.floor(Math.round((lng + LNG_MAX) * LNG_INTEGER_MULTIPLIER * 1e6) / 1e6);

  let code = '';

  // Grid digits (11th onward) are taken from the low-order end first.
  if (length > PAIR_CODE_LENGTH) {
    for (let i = 0; i < GRID_CODE_LENGTH; i += 1) {
      const row = latValue % GRID_ROWS;
      const col = lngValue % GRID_COLUMNS;
      code = ALPHABET[row * GRID_COLUMNS + col] + code;
      latValue = Math.floor(latValue / GRID_ROWS);
      lngValue = Math.floor(lngValue / GRID_COLUMNS);
    }
  } else {
    latValue = Math.floor(latValue / GRID_ROWS ** GRID_CODE_LENGTH);
    lngValue = Math.floor(lngValue / GRID_COLUMNS ** GRID_CODE_LENGTH);
  }

  for (let i = 0; i < PAIR_CODE_LENGTH / 2; i += 1) {
    code = ALPHABET[latValue % ENCODING_BASE] + ALPHABET[lngValue % ENCODING_BASE] + code;
    latValue = Math.floor(latValue / ENCODING_BASE);
    lngValue = Math.floor(lngValue / ENCODING_BASE);
  }

  code = code.slice(0, SEPARATOR_POSITION) + SEPARATOR + code.slice(SEPARATOR_POSITION);

  if (length >= SEPARATOR_POSITION) return code.slice(0, length + 1);
  return code.slice(0, length) + PADDING.repeat(SEPARATOR_POSITION - length) + SEPARATOR;
}

/**
 * Decodes a full Plus Code into its bounding box and centre point.
 */
export function decode(code) {
  if (!isFull(code)) {
    throw new Error(`Not a valid full Plus Code: ${code}`);
  }

  // Characters beyond the 15th add no precision, so they are ignored.
  const body = code
    .toUpperCase()
    .replace(new RegExp(`\\${SEPARATOR}`, 'g'), '')
    .replace(new RegExp(`${PADDING}+`, 'g'), '')
    .slice(0, MAX_CODE_LENGTH);

  let south = 0;
  let west = 0;
  let latResolution = 400;
  let lngResolution = 400;
  let digit = 0;

  while (digit < Math.min(body.length, PAIR_CODE_LENGTH)) {
    latResolution /= 20;
    lngResolution /= 20;
    south += latResolution * ALPHABET.indexOf(body[digit]);
    west += lngResolution * ALPHABET.indexOf(body[digit + 1]);
    digit += 2;
  }

  while (digit < body.length) {
    latResolution /= GRID_ROWS;
    lngResolution /= GRID_COLUMNS;

    const index = ALPHABET.indexOf(body[digit]);
    south += latResolution * Math.floor(index / GRID_COLUMNS);
    west += lngResolution * (index % GRID_COLUMNS);
    digit += 1;
  }

  const latLo = south - LAT_MAX;
  const lngLo = west - LNG_MAX;

  return {
    latLo,
    lngLo,
    latHi: latLo + latResolution,
    lngHi: lngLo + lngResolution,
    lat: latLo + latResolution / 2,
    lng: lngLo + lngResolution / 2,
    codeLength: body.length,
    // Side length of the decoded cell, in metres (roughly, at the equator).
    precisionMeters: Math.round(latResolution * 111_320),
  };
}

/**
 * Removes the leading characters a nearby reference location makes redundant,
 * producing the short form people actually share (e.g. "8W66+RV9").
 */
export function shorten(code, referenceLatitude, referenceLongitude) {
  if (!isFull(code)) throw new Error(`Not a valid full Plus Code: ${code}`);
  if (code.includes(PADDING)) throw new Error('Cannot shorten padded codes.');

  const upper = code.toUpperCase();
  const area = decode(upper);
  if (area.codeLength < MIN_TRIMMABLE_CODE_LENGTH) {
    throw new Error(`Code must be at least ${MIN_TRIMMABLE_CODE_LENGTH} characters to shorten.`);
  }

  const refLat = clipLatitude(referenceLatitude);
  const refLng = normalizeLongitude(referenceLongitude);
  const range = Math.max(Math.abs(area.lat - refLat), Math.abs(area.lng - refLng));

  // Trim the largest prefix whose cell still unambiguously contains the
  // reference point. 0.3 rather than 0.5 leaves a safety margin.
  for (let i = PAIR_RESOLUTIONS.length - 2; i >= 1; i -= 1) {
    if (range < PAIR_RESOLUTIONS[i] * 0.3) return upper.slice((i + 1) * 2);
  }
  return upper;
}

/**
 * Expands a short code (e.g. "8W66+RV9") into a full one using a nearby
 * reference coordinate, picking the candidate closest to that reference.
 */
export function recoverNearest(shortCode, referenceLatitude, referenceLongitude) {
  if (isFull(shortCode)) return shortCode.toUpperCase();
  if (!isShort(shortCode)) throw new Error(`Not a valid short Plus Code: ${shortCode}`);

  const code = shortCode.toUpperCase();
  const refLat = clipLatitude(referenceLatitude);
  const refLng = normalizeLongitude(referenceLongitude);

  const paddingLength = SEPARATOR_POSITION - code.indexOf(SEPARATOR);
  const resolution = 20 ** (2 - paddingLength / 2);
  const halfRes = resolution / 2;

  const prefix = encode(refLat, refLng).slice(0, paddingLength);
  const candidate = decode(prefix + code);

  let { lat, lng } = candidate;

  // The prefix may put us in the neighbouring cell; step to whichever is nearer.
  if (refLat + halfRes < lat && lat - resolution >= -LAT_MAX) {
    lat -= resolution;
  } else if (refLat - halfRes > lat && lat + resolution <= LAT_MAX) {
    lat += resolution;
  }

  if (refLng + halfRes < lng) {
    lng -= resolution;
  } else if (refLng - halfRes > lng) {
    lng += resolution;
  }

  return encode(lat, lng, candidate.codeLength);
}

/**
 * Pulls a Plus Code out of a free-form query such as
 * "8W66+RV9, H. Joaquino St, Cebu City, 6000 Cebu".
 *
 * @returns {{ code: string, rest: string } | null}
 */
export function extract(query) {
  if (typeof query !== 'string') return null;

  const match = query.match(CODE_PATTERN);
  if (!match || !isValid(match[1])) return null;

  const rest = (query.slice(0, match.index) + query.slice(match.index + match[1].length))
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s*,\s*,\s*/g, ', ')
    .trim();

  return { code: match[1].toUpperCase(), rest };
}
