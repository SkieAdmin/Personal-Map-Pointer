import { Router } from 'express';
import { store } from '../store.js';
import { validateMarker } from '../validate.js';
import { fromGeoJSON, toGeoJSON } from '../geojson.js';

const router = Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/markers -> all markers
router.get('/', asyncRoute(async (_req, res) => {
  const markers = await store.list();
  res.json({ count: markers.length, markers });
}));

/** Identity used to spot a pin that is already on the map. */
const identity = (marker) => [
  marker.title.trim().toLowerCase(),
  marker.lat.toFixed(6),
  marker.lng.toFixed(6),
].join('|');

// GET /api/markers/export -> the GeoJSON file the Export button downloads.
// Declared before /:id, which would otherwise capture "export".
router.get('/export', asyncRoute(async (_req, res) => {
  const markers = await store.list();

  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="map-pointer-pins.geojson"');
  res.send(JSON.stringify(toGeoJSON(markers), null, 2));
}));

// POST /api/markers/import?mode=merge|replace -> load a GeoJSON file back in.
// merge (the default) adds pins and skips ones already present; replace swaps
// the whole collection.
router.post('/import', asyncRoute(async (req, res) => {
  const mode = req.query.mode === 'replace' ? 'replace' : 'merge';

  let parsed;
  try {
    parsed = fromGeoJSON(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (parsed.markers.length === 0) {
    return res.status(400).json({
      error: 'No point features found in that file.',
      skipped: parsed.skipped,
    });
  }

  const validated = parsed.markers.map((marker) => validateMarker(marker));
  const failed = validated.flatMap(({ errors }, index) => (
    errors.length ? [{ index, errors }] : []));
  if (failed.length) {
    return res.status(400).json({ error: 'Validation failed.', details: failed });
  }

  const incoming = validated.map(({ value }) => value);

  if (mode === 'replace') {
    const markers = await store.replaceAll(incoming);
    return res.status(201).json({
      mode, imported: markers.length, duplicates: 0, skipped: parsed.skipped, markers,
    });
  }

  const seen = new Set((await store.list()).map(identity));
  const markers = [];
  let duplicates = 0;

  for (const value of incoming) {
    const key = identity(value);
    // Re-importing the same file should not double every pin.
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    markers.push(await store.create(value));
  }

  res.status(201).json({
    mode, imported: markers.length, duplicates, skipped: parsed.skipped, markers,
  });
}));

// GET /api/markers/:id -> one marker
router.get('/:id', asyncRoute(async (req, res) => {
  const marker = await store.get(req.params.id);
  if (!marker) return res.status(404).json({ error: 'Marker not found.' });
  res.json(marker);
}));

// POST /api/markers -> create one marker, or many when given an array
router.post('/', asyncRoute(async (req, res) => {
  if (Array.isArray(req.body)) {
    const validated = req.body.map((item) => validateMarker(item));
    const failed = validated.flatMap(({ errors }, i) =>
      errors.length ? [{ index: i, errors }] : []);
    if (failed.length) return res.status(400).json({ error: 'Validation failed.', details: failed });

    const created = [];
    for (const { value } of validated) created.push(await store.create(value));
    return res.status(201).json({ count: created.length, markers: created });
  }

  const { errors, value } = validateMarker(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const marker = await store.create(value);
  res.status(201).json(marker);
}));

// PATCH /api/markers/:id -> partial update (also used for drag-to-move)
router.patch('/:id', asyncRoute(async (req, res) => {
  const { errors, value } = validateMarker(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const marker = await store.update(req.params.id, value);
  if (!marker) return res.status(404).json({ error: 'Marker not found.' });
  res.json(marker);
}));

// PUT /api/markers/:id -> full replace
router.put('/:id', asyncRoute(async (req, res) => {
  const { errors, value } = validateMarker(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const marker = await store.update(req.params.id, {
    description: '',
    color: 'blue',
    ...value,
  });
  if (!marker) return res.status(404).json({ error: 'Marker not found.' });
  res.json(marker);
}));

// DELETE /api/markers/:id -> remove one
router.delete('/:id', asyncRoute(async (req, res) => {
  const removed = await store.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Marker not found.' });
  res.status(204).end();
}));

// DELETE /api/markers -> remove all
router.delete('/', asyncRoute(async (_req, res) => {
  const removed = await store.clear();
  res.json({ removed });
}));

export default router;
