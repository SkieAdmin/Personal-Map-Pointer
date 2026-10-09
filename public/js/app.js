const COLORS = {
  blue: '#2f81f7',
  red: '#f85149',
  green: '#3fb950',
  orange: '#f0883e',
  purple: '#a371f7',
  gray: '#8b98a5',
};

const el = (id) => document.getElementById(id);

const dom = {
  pinList: el('pin-list'),
  pinCount: el('pin-count'),
  emptyState: el('empty-state'),
  searchForm: el('search-form'),
  searchInput: el('search-input'),
  searchResults: el('search-results'),
  fitBtn: el('fit-btn'),
  exportBtn: el('export-btn'),
  importBtn: el('import-btn'),
  importFile: el('import-file'),
  clearBtn: el('clear-btn'),
  locateBtn: el('locate-btn'),
  toast: el('toast'),
  dialog: el('pin-dialog'),
  form: el('pin-form'),
  dialogTitle: el('dialog-title'),
  dialogError: el('dialog-error'),
  dialogCancel: el('dialog-cancel'),
  title: el('pin-title'),
  description: el('pin-description'),
  lat: el('pin-lat'),
  lng: el('pin-lng'),
  color: el('pin-color'),
};

/** id -> marker record, and id -> Leaflet layer */
const markers = new Map();
const layers = new Map();
let editingId = null;
let activeId = null;

/* ---------------- map ---------------- */

const map = L.map('map', { zoomControl: true }).setView([20, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

L.control.scale({ imperial: false }).addTo(map);

function pinIcon(color) {
  const fill = COLORS[color] ?? COLORS.blue;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">
    <path d="M13 1C6.4 1 1 6.3 1 12.9 1 21.5 13 37 13 37s12-15.5 12-24.1C25 6.3 19.6 1 13 1z"
          fill="${fill}" stroke="#0f1419" stroke-width="2"/>
    <circle cx="13" cy="13" r="4.5" fill="#0f1419" fill-opacity="0.75"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: 'pin-marker',
    iconSize: [26, 38],
    iconAnchor: [13, 37],
    popupAnchor: [0, -32],
  });
}

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const details = Array.isArray(payload?.details) ? ` ${payload.details.join(' ')}` : '';
    throw new Error(`${payload?.error ?? `Request failed (${response.status})`}${details}`);
  }
  return payload;
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3200);
}

/* ---------------- rendering ---------------- */

function popupContent(marker) {
  const wrap = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'popup-title';
  title.textContent = marker.title;
  wrap.append(title);

  if (marker.description) {
    const desc = document.createElement('div');
    desc.className = 'popup-desc';
    desc.textContent = marker.description;
    wrap.append(desc);
  }

  const coords = document.createElement('div');
  coords.className = 'popup-coords';
  coords.textContent = `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`;
  wrap.append(coords);

  return wrap;
}

function drawMarker(marker) {
  const existing = layers.get(marker.id);
  if (existing) map.removeLayer(existing);

  const layer = L.marker([marker.lat, marker.lng], {
    icon: pinIcon(marker.color),
    draggable: true,
    title: marker.title,
  }).addTo(map);

  layer.bindPopup(popupContent(marker));
  layer.on('click', () => setActive(marker.id, { pan: false }));

  // Dragging a pin persists its new position.
  layer.on('dragend', async () => {
    const { lat, lng } = layer.getLatLng();
    try {
      const updated = await api(`/api/markers/${marker.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ lat, lng }),
      });
      markers.set(updated.id, updated);
      layer.setPopupContent(popupContent(updated));
      renderList();
      toast(`Moved "${updated.title}"`);
    } catch (err) {
      layer.setLatLng([marker.lat, marker.lng]); // roll back on failure
      toast(err.message, true);
    }
  });

  layers.set(marker.id, layer);
}

function renderList() {
  const items = [...markers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  dom.pinCount.textContent = String(items.length);
  dom.emptyState.hidden = items.length > 0;
  dom.pinList.replaceChildren();

  for (const marker of items) {
    const li = document.createElement('li');
    li.className = 'pin-item' + (marker.id === activeId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'pin-dot';
    dot.style.background = COLORS[marker.color] ?? COLORS.blue;

    const body = document.createElement('div');
    body.className = 'pin-body';
    body.title = 'Zoom to this pin';
    body.addEventListener('click', () => setActive(marker.id));

    const name = document.createElement('div');
    name.className = 'pin-name';
    name.textContent = marker.title;
    body.append(name);

    if (marker.description) {
      const desc = document.createElement('div');
      desc.className = 'pin-desc';
      desc.textContent = marker.description;
      body.append(desc);
    }

    const coords = document.createElement('div');
    coords.className = 'pin-coords';
    coords.textContent = `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`;
    body.append(coords);

    const tools = document.createElement('div');
    tools.className = 'pin-tools';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openDialog(marker));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn danger';
    delBtn.textContent = 'Del';
    delBtn.addEventListener('click', () => deleteMarker(marker));

    tools.append(editBtn, delBtn);
    li.append(dot, body, tools);
    dom.pinList.append(li);
  }
}

function setActive(id, { pan = true } = {}) {
  activeId = id;
  const marker = markers.get(id);
  const layer = layers.get(id);
  if (!marker || !layer) return;

  if (pan) map.flyTo([marker.lat, marker.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
  layer.openPopup();
  renderList();
}

function fitAll() {
  const items = [...markers.values()];
  if (items.length === 0) return toast('No pins to fit yet.');
  if (items.length === 1) return map.flyTo([items[0].lat, items[0].lng], 14, { duration: 0.6 });

  map.flyToBounds(L.latLngBounds(items.map((m) => [m.lat, m.lng])), { padding: [60, 60], duration: 0.6 });
}

/* ---------------- dialog ---------------- */

function openDialog(marker, prefill) {
  editingId = marker?.id ?? null;
  dom.dialogTitle.textContent = marker ? 'Edit pin' : 'Add pin';
  dom.dialogError.hidden = true;

  const source = marker ?? prefill ?? {};
  dom.title.value = source.title ?? '';
  dom.description.value = source.description ?? '';
  dom.lat.value = source.lat ?? '';
  dom.lng.value = source.lng ?? '';
  dom.color.value = source.color ?? 'blue';

  dom.dialog.showModal();
  dom.title.focus();
  dom.title.select();
}

dom.dialogCancel.addEventListener('click', () => dom.dialog.close());

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const body = {
    title: dom.title.value.trim(),
    description: dom.description.value.trim(),
    lat: Number(dom.lat.value),
    lng: Number(dom.lng.value),
    color: dom.color.value,
  };

  if (!body.title) {
    dom.dialogError.textContent = 'Title is required.';
    dom.dialogError.hidden = false;
    return;
  }

  try {
    const saved = editingId
      ? await api(`/api/markers/${editingId}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/api/markers', { method: 'POST', body: JSON.stringify(body) });

    markers.set(saved.id, saved);
    drawMarker(saved);
    activeId = saved.id;
    renderList();
    dom.dialog.close();
    toast(editingId ? `Updated "${saved.title}"` : `Added "${saved.title}"`);
  } catch (err) {
    dom.dialogError.textContent = err.message;
    dom.dialogError.hidden = false;
  }
});

/* ---------------- actions ---------------- */

async function deleteMarker(marker) {
  if (!confirm(`Delete "${marker.title}"?`)) return;
  try {
    await api(`/api/markers/${marker.id}`, { method: 'DELETE' });
    const layer = layers.get(marker.id);
    if (layer) map.removeLayer(layer);
    layers.delete(marker.id);
    markers.delete(marker.id);
    if (activeId === marker.id) activeId = null;
    renderList();
    toast(`Deleted "${marker.title}"`);
  } catch (err) {
    toast(err.message, true);
  }
}

// Clicking empty map space starts a new pin, pre-filled by reverse geocoding.
map.on('click', async (event) => {
  const { lat, lng } = event.latlng;
  openDialog(null, { lat: lat.toFixed(6), lng: lng.toFixed(6) });

  try {
    const place = await api(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);
    // Only fill in a suggestion while the dialog is still open and untouched.
    if (dom.dialog.open && !editingId && !dom.title.value) {
      dom.title.value = place.name ?? place.label?.split(',')[0] ?? '';
      if (!dom.description.value && place.label) dom.description.value = place.label;
      dom.title.select();
    }
  } catch {
    /* the suggestion is optional - the user can always type a title */
  }
});

dom.fitBtn.addEventListener('click', fitAll);

dom.clearBtn.addEventListener('click', async () => {
  if (markers.size === 0) return toast('Nothing to clear.');
  if (!confirm(`Delete all ${markers.size} pins?`)) return;
  try {
    const { removed } = await api('/api/markers', { method: 'DELETE' });
    for (const layer of layers.values()) map.removeLayer(layer);
    layers.clear();
    markers.clear();
    activeId = null;
    renderList();
    toast(`Deleted ${removed} pins`);
  } catch (err) {
    toast(err.message, true);
  }
});

dom.exportBtn.addEventListener('click', () => {
  if (markers.size === 0) return toast('No pins to export.');

  // The server builds the GeoJSON, so export and import agree on one shape.
  const link = document.createElement('a');
  link.href = '/api/markers/export';
  link.download = 'map-pointer-pins.geojson';
  link.click();
  toast(`Exported ${markers.size} pins`);
});

/* ---------------- import ---------------- */

async function importText(text, filename) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    toast(`${filename} is not valid JSON.`, true);
    return;
  }

  try {
    const result = await api('/api/markers/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    // Re-read rather than guess, so the map matches the server exactly.
    await reload({ fit: true });

    const parts = [`Imported ${result.imported} pin${result.imported === 1 ? '' : 's'}`];
    if (result.duplicates) parts.push(`${result.duplicates} already on the map`);
    if (result.skipped) parts.push(`${result.skipped} non-point feature(s) skipped`);
    toast(parts.join(' - '));
  } catch (err) {
    toast(err.message, true);
  }
}

async function importFiles(files) {
  const file = files?.[0];
  if (!file) return;

  if (files.length > 1) toast(`Importing ${file.name} only - one file at a time.`);

  try {
    await importText(await file.text(), file.name);
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, true);
  }
}

dom.importBtn.addEventListener('click', () => dom.importFile.click());

dom.importFile.addEventListener('change', async (event) => {
  await importFiles(event.target.files);
  // Reset so choosing the same file twice fires again.
  event.target.value = '';
});

// Dropping a file anywhere on the map imports it too.
const mapWrap = document.querySelector('.map-wrap');
let dragDepth = 0;

const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

mapWrap.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  mapWrap.classList.add('drop-target');
});

mapWrap.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

mapWrap.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) mapWrap.classList.remove('drop-target');
});

mapWrap.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  mapWrap.classList.remove('drop-target');
  await importFiles(event.dataTransfer.files);
});

/* ---------------- search ---------------- */

dom.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = dom.searchInput.value.trim();
  if (q.length < 2) return toast('Type at least 2 characters.', true);

  dom.searchResults.replaceChildren();
  dom.searchResults.hidden = false;
  const loading = document.createElement('li');
  loading.className = 'muted';
  loading.textContent = 'Searching OpenStreetMap...';
  dom.searchResults.append(loading);

  // The map centre lets the server resolve short Plus Codes like "8W66+RV9".
  const centre = map.getCenter();

  try {
    const { results, note } = await api(
      `/api/geocode/search?q=${encodeURIComponent(q)}&lat=${centre.lat}&lng=${centre.lng}`);
    dom.searchResults.replaceChildren();
    if (note) toast(note);

    if (results.length === 0) {
      const none = document.createElement('li');
      none.className = 'muted';
      none.textContent = 'No places found.';
      dom.searchResults.append(none);
      return;
    }

    for (const place of results) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.label;
      button.addEventListener('click', () => {
        map.flyTo([place.lat, place.lng], 15, { duration: 0.8 });
        openDialog(null, {
          title: place.label.split(',')[0],
          description: place.label,
          lat: place.lat,
          lng: place.lng,
        });
      });
      li.append(button);
      dom.searchResults.append(li);
    }
  } catch (err) {
    dom.searchResults.hidden = true;
    toast(err.message, true);
  }
});

/* ---------------- GPS ---------------- */

let meLayer = null;

function showMe(position) {
  const { latitude, longitude, accuracy } = position.coords;

  if (meLayer) map.removeLayer(meLayer);

  // A dot for the position plus a circle showing the reported accuracy.
  meLayer = L.layerGroup([
    L.circle([latitude, longitude], {
      radius: accuracy,
      color: COLORS.blue,
      weight: 1,
      fillOpacity: 0.12,
    }),
    L.marker([latitude, longitude], {
      icon: L.divIcon({ className: 'me-marker', iconSize: [16, 16] }),
      title: 'Your location',
      zIndexOffset: 1000,
    }),
  ]).addTo(map);

  const zoom = accuracy > 2000 ? 12 : accuracy > 500 ? 14 : 16;
  map.flyTo([latitude, longitude], zoom, { duration: 0.8 });

  toast(`Found you within about ${Math.round(accuracy)} m - click "Pin my location" to save it`);

  // Offer to turn the fix into a real pin.
  dom.locateBtn.textContent = 'Pin my location';
  dom.locateBtn.dataset.mode = 'pin';
  dom.locateBtn.dataset.lat = String(latitude);
  dom.locateBtn.dataset.lng = String(longitude);
}

function geolocationError(error) {
  const messages = {
    1: 'Location permission was denied. Allow location access in your site settings, then try again.',
    2: 'Your device could not get a position fix. On a desktop without GPS this often fails - try again or search instead.',
    3: 'Locating timed out. Try again, ideally near a window or with Wi-Fi on.',
  };
  toast(messages[error.code] ?? `Could not get your location: ${error.message}`, true);
}

dom.locateBtn.addEventListener('click', () => {
  // Second press turns the existing fix into a pin.
  if (dom.locateBtn.dataset.mode === 'pin') {
    openDialog(null, {
      title: 'My location',
      lat: Number(dom.locateBtn.dataset.lat).toFixed(6),
      lng: Number(dom.locateBtn.dataset.lng).toFixed(6),
      color: 'purple',
    });
    return;
  }

  if (!navigator.geolocation) {
    toast('This browser does not support geolocation.', true);
    return;
  }

  // Geolocation needs a secure context. localhost counts as one, so this works
  // over plain http during development but will need https once deployed.
  if (!window.isSecureContext) {
    toast('Geolocation needs https (or localhost). This page is not a secure context.', true);
    return;
  }

  dom.locateBtn.disabled = true;
  const previousLabel = dom.locateBtn.textContent;
  dom.locateBtn.textContent = 'Locating...';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      dom.locateBtn.disabled = false;
      showMe(position);
    },
    (error) => {
      dom.locateBtn.disabled = false;
      dom.locateBtn.textContent = previousLabel;
      geolocationError(error);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
});

/* ---------------- boot ---------------- */

/**
 * Rebuilds the map from whatever the server currently holds. Used at startup
 * and after an import, where pin ids change and guessing would drift.
 */
async function reload({ fit = false } = {}) {
  const { markers: saved } = await api('/api/markers');

  for (const layer of layers.values()) map.removeLayer(layer);
  layers.clear();
  markers.clear();

  for (const marker of saved) {
    markers.set(marker.id, marker);
    drawMarker(marker);
  }

  if (!markers.has(activeId)) activeId = null;
  renderList();
  if (fit && saved.length > 0) fitAll();

  return saved;
}

(async function boot() {
  try {
    await reload({ fit: true });
  } catch (err) {
    toast(`Could not load pins: ${err.message}`, true);
  }
})();
