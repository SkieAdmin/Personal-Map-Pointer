export const COLORS = ['blue', 'red', 'green', 'orange', 'purple', 'gray'];

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;

function num(value) {
  // Accept both JSON numbers and numeric strings from form posts.
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Validates marker input.
 * @param {object} body raw request body
 * @param {boolean} partial when true, missing fields are skipped (PATCH semantics)
 * @returns {{ errors: string[], value: object }}
 */
export function validateMarker(body, { partial = false } = {}) {
  const errors = [];
  const value = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object.'], value };
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (has('title') || !partial) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) errors.push('title is required and must be a non-empty string.');
    else if (title.length > MAX_TITLE) errors.push(`title must be at most ${MAX_TITLE} characters.`);
    else value.title = title;
  }

  if (has('description')) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > MAX_DESCRIPTION) {
      errors.push(`description must be at most ${MAX_DESCRIPTION} characters.`);
    } else {
      value.description = description;
    }
  }

  if (has('lat') || !partial) {
    const lat = num(body.lat);
    if (lat === null || lat < -90 || lat > 90) errors.push('lat must be a number between -90 and 90.');
    else value.lat = lat;
  }

  if (has('lng') || !partial) {
    const lng = num(body.lng);
    if (lng === null || lng < -180 || lng > 180) errors.push('lng must be a number between -180 and 180.');
    else value.lng = lng;
  }

  if (has('color')) {
    if (!COLORS.includes(body.color)) errors.push(`color must be one of: ${COLORS.join(', ')}.`);
    else value.color = body.color;
  }

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push('No updatable fields provided.');
  }

  return { errors, value };
}
