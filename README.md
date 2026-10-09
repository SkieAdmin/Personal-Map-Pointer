# Map Pointer

A Node.js / Express app for marking multiple points on a map. Uses **OpenStreetMap**
for tiles (via Leaflet) and the **Nominatim** OpenStreetMap API for place search and
reverse geocoding. No API key required.

## Features

- Click anywhere on the map to drop a pin; the title is pre-filled from reverse geocoding
- Search for a place by name and pin it straight from the results
- **Plus Codes work** (e.g. `8W66+RV9, Cebu City`) - these are decoded locally,
  because OpenStreetMap does not understand them (see below)
- **Street intersections work** (e.g. `N.Bacalso Ave, Corner V Rama Ave, Cebu City`)
  - resolved through Overpass, because Nominatim has no intersection syntax
- **"Use my location (GPS)"** centres the map on you and can pin the fix
- Unlimited pins, each with a title, description and one of six colours
- Drag a pin to move it - the new position is saved automatically
- Edit and delete individual pins, or clear them all
- "Fit" zooms the map to show every pin at once
- **Export and import** pins as GeoJSON - drag a file onto the map, or use the
  Import button. Re-importing the same file does not duplicate anything
- Pins are saved to **SQLite** the moment you make them - no save button, and
  they survive a crash or a hard kill
- Reachable over **Tailscale**, so you can use it from your phone
- Full REST API, usable on its own

## Getting started

```bash
npm install
npm start          # or: npm run dev   (restarts on file changes)
```

Then open <http://localhost:3000>.

Set a different port with `PORT=8080 npm start`.

There are **no native dependencies** - SQLite comes from Node's built-in
`node:sqlite` module, so `npm install` never has to compile anything.

## Storage (SQLite)

Pins live in `data/map-pointer.db`, written through Node's built-in
`node:sqlite`. Every create, edit, move and delete commits straight away, so
there is nothing to save by hand and nothing buffered to lose.

```sql
CREATE TABLE markers (
  id          TEXT PRIMARY KEY,   -- uuid
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  color       TEXT NOT NULL DEFAULT 'blue',
  created_at  TEXT NOT NULL,      -- ISO 8601
  updated_at  TEXT NOT NULL
);
```

Settings that matter:

- `journal_mode = WAL` - the database stays consistent if the process dies
  mid-write, and reads are not blocked by a write.
- `synchronous = NORMAL` - crash-safe under WAL. Use `FULL` if you also want to
  be covered against sudden power loss, at the cost of speed.
- Pins are listed by `rowid`, which is true insertion order. `created_at` only
  has millisecond resolution, so a bulk import would otherwise come back
  shuffled.
- An import with `?mode=replace` runs in one transaction, so a failure part-way
  through leaves your existing pins untouched.

**Your old pins move across automatically.** On first start, if
`data/markers.json` has pins and the database is empty, they are copied in with
their ids and timestamps intact, and the file is renamed to
`markers.json.migrated` rather than deleted.

Point it somewhere else with `MAP_POINTER_DB=/path/to/pins.db npm start`.
The file is plain SQLite, so `sqlite3 data/map-pointer.db` works for ad-hoc
queries and `.backup` for snapshots.

## Access over Tailscale

The server listens on every interface by default, so once Tailscale is up the
app is already reachable from your other devices. Startup prints the URLs:

```
  http://localhost:3000     this machine - GPS works (localhost is a secure context)
  http://100.x.y.z:3000     over Tailscale - GPS blocked on a bare IP, see below
  http://192.168.x.y:3000   local network via WiFi
```

### Use https, or the GPS button will not work

This is the one thing worth knowing up front. Geolocation needs a *secure
context*. `localhost` counts as one; **`http://100.x.y.z` does not**, so the
GPS button will refuse to run when you open the app over Tailscale by IP.

`tailscale serve` fixes it by putting a real certificate in front:

```bash
tailscale serve --bg 3000          # proxy https -> localhost:3000
tailscale serve status             # prints the https://<machine>.<tailnet>.ts.net URL
```

Open that `https://...ts.net` URL and GPS works, because the browser now sees a
secure origin. To stop sharing: `tailscale serve reset`.

### Choosing what it listens on

| `HOST` | Binds to | Use when |
| --- | --- | --- |
| *(unset)* | every interface | the simple default |
| `tailscale` | the tailnet address only | you do not want it on café Wi-Fi |
| `localhost` | loopback only | `tailscale serve` is the only way in |

```bash
HOST=tailscale npm start      # refuses connections from any other network
HOST=localhost npm start      # pair this with tailscale serve
```

`HOST=tailscale` fails fast with a clear message if Tailscale is not connected,
rather than silently binding to nothing useful.

### Locking it to you

There is **no authentication**. On a tailnet that is usually fine - only your
own devices can reach it - but anyone on the tailnet, including a shared node,
can edit your pins.

If you want it limited to your own login, set an allowlist:

```bash
ALLOWED_TAILSCALE_USERS=you@example.com HOST=localhost npm start
tailscale serve --bg 3000
```

Requests then need a `Tailscale-User-Login` header matching the list, which
`tailscale serve` sets for you (and strips if a client tries to supply its own).

**This only means anything behind `tailscale serve`.** If port 3000 is reachable
directly, anyone who can reach it can simply send the header themselves - so
pair it with `HOST=localhost`. The server prints a warning at startup if you
enable the allowlist without doing that.

Do not put this on `tailscale funnel` (which exposes it to the public internet)
without the allowlist, since there is nothing else stopping a stranger editing
your map.

## REST API

| Method   | Endpoint                                | Description                                   |
| -------- | --------------------------------------- | --------------------------------------------- |
| `GET`    | `/api/markers`                          | List all pins                                 |
| `GET`    | `/api/markers/:id`                      | Get one pin                                   |
| `POST`   | `/api/markers`                          | Create a pin (or many - send a JSON array)    |
| `PATCH`  | `/api/markers/:id`                      | Partial update (used for drag-to-move)        |
| `PUT`    | `/api/markers/:id`                      | Replace a pin                                 |
| `DELETE` | `/api/markers/:id`                      | Delete one pin                                |
| `DELETE` | `/api/markers`                          | Delete all pins                               |
| `GET`    | `/api/markers/export`                   | Download all pins as GeoJSON                  |
| `POST`   | `/api/markers/import?mode=merge`        | Load pins from GeoJSON (`merge` or `replace`) |
| `GET`    | `/api/geocode/search?q=...&limit=5`     | Place search (Nominatim), Plus Codes included |
| `GET`    | `/api/geocode/reverse?lat=..&lng=..`    | Address for a coordinate (Nominatim)          |
| `GET`    | `/api/health`                           | Health check                                  |

### Marker shape

```json
{
  "id": "uuid",
  "title": "Eiffel Tower",
  "description": "Paris landmark",
  "lat": 48.8584,
  "lng": 2.2945,
  "color": "red",
  "createdAt": "2026-10-09T16:38:44.585Z",
  "updatedAt": "2026-10-09T16:38:44.585Z"
}
```

`title`, `lat` and `lng` are required. `lat` must be -90..90, `lng` -180..180, and
`color` one of `blue`, `red`, `green`, `orange`, `purple`, `gray`.
Validation failures return `400` with a `details` array naming each problem.

### Examples

Add one pin:

```bash
curl -X POST http://localhost:3000/api/markers \
  -H 'Content-Type: application/json' \
  -d '{"title":"Eiffel Tower","lat":48.8584,"lng":2.2945,"color":"red"}'
```

Add several pins in one request:

```bash
curl -X POST http://localhost:3000/api/markers \
  -H 'Content-Type: application/json' \
  -d '[{"title":"Colosseum","lat":41.8902,"lng":12.4922},
       {"title":"Brandenburg Gate","lat":52.5163,"lng":13.3777}]'
```

Move a pin:

```bash
curl -X PATCH http://localhost:3000/api/markers/<id> \
  -H 'Content-Type: application/json' \
  -d '{"lat":48.86,"lng":2.30}'
```

## Export and import

**Export** downloads a GeoJSON `FeatureCollection` of Points. **Import** reads one
back - click Import, or drag the file anywhere onto the map.

```bash
curl -o pins.geojson http://localhost:3000/api/markers/export

curl -X POST http://localhost:3000/api/markers/import   -H 'Content-Type: application/geo+json' --data-binary @pins.geojson
```

```json
{ "mode": "merge", "imported": 4, "duplicates": 0, "skipped": 0, "markers": [ ... ] }
```

**Two modes.** `merge` (the default) adds the pins and skips any already on the
map, matched on title plus coordinates - so importing the same file twice is
safe and reports `duplicates` instead of doubling everything. `?mode=replace`
swaps the whole collection in one atomic write.

**Import is deliberately forgiving**, since files come from all over:

- `title`, `name`, `Name` or `label` for the title; `description`, `desc`,
  `notes` or `comment` for the body
- `color`, `colour` or simplestyle `marker-color`. Any hex is snapped to the
  nearest palette colour, so `#ff0000` becomes red
- a bare `Feature`, a bare `Point`, a single-point `MultiPoint`, the plain
  marker array this API returns, or the `{count, markers}` envelope from
  `GET /api/markers`
- untitled points are named `Imported pin N` rather than rejected
- lines, polygons and malformed entries are counted in `skipped`, not silently
  dropped

Both directions share one definition in `src/geojson.js`, so a round trip is
lossless. Note that GeoJSON is **longitude first** (`[lng, lat]`) - the opposite
of how the rest of the app passes coordinates, and the usual source of bugs
here, so it is covered in both directions by tests.

Files are exported as plain GeoJSON, so they also open in
[geojson.io](https://geojson.io), QGIS, GitHub and Google Earth.

## Plus Codes (Google "plus codes" / Open Location Code)

A Plus Code such as `8W66+RV9` is **not an address** - it is a coordinate encoded
into a short string. OpenStreetMap and Nominatim have no idea what they are, so
searching for one against Nominatim always returns zero results. Google Maps
supports them; OSM does not.

So the app decodes them itself, in `src/pluscode.js`. No API call is involved -
it is pure arithmetic.

```bash
# Short code plus a locality: the locality is geocoded and used as the reference
curl "http://localhost:3000/api/geocode/search?q=8W66%2BRV9,%20Cebu%20City"

# Full (global) code: resolved directly
curl "http://localhost:3000/api/geocode/search?q=7Q258W66%2BRV9"
```

**Short vs full codes.** `8W66+RV9` is a *short* code - the first four characters
have been dropped, so on its own it is ambiguous and could match a cell anywhere
in the world. It needs a reference location, which can come from either:

1. the rest of the query (`8W66+RV9, Cebu City` - the locality is geocoded first), or
2. the `lat`/`lng` query params - the web UI always sends the current map centre,
   so typing a bare short code resolves against wherever you are looking.

With neither, the API returns `422` and explains what to add. A full code like
`7Q258W66+RV9` needs no reference at all.

Responses for a Plus Code carry a couple of extra fields:

```json
{
  "label": "7Q258W66+RV9 (H. Joaquino St, Cebu City, 6000 Cebu)",
  "lat": 10.3120375,
  "lng": 123.9122344,
  "type": "plus_code",
  "plusCode": "7Q258W66+RV9",
  "precisionMeters": 3
}
```

## Street intersections ("A corner B")

Nominatim matches *place names*, and an intersection is not a place - it is the
point where two named ways meet. So `N.Bacalso Ave, Corner V Rama Ave, Cebu City`
returns nothing from Nominatim even though both avenues are in OSM. Google
understands this phrasing; Nominatim does not.

The app detects these queries and answers them with the
[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), which can ask
for exactly the right thing: *the nodes shared by a way named A and a way named B*.

```bash
curl "http://localhost:3000/api/geocode/search?q=N.Bacalso%20Ave,%20Corner%20V%20Rama%20Ave,%20Cebu%20City"
```

```json
{
  "label": "N.Bacalso Ave & V Rama Ave, Cebu City (traffic signals)",
  "lat": 10.2972341, "lng": 123.8883167,
  "type": "intersection",
  "streets": ["N.Bacalso Ave", "V Rama Ave"],
  "nodeCount": 2
}
```

Recognised forms (all case-insensitive):

| Query | |
| --- | --- |
| `A, Corner B, City` | the comma before `Corner` is ignored |
| `A corner B, City` | |
| `A cor. B, City` | also `crn.` |
| `corner of A and B, City` | |
| `A & B, City` / `A / B, City` | |

How it works, in `src/intersection.js` and `src/overpass.js`:

1. The query is split into street A, street B and a locality.
2. Each street name is reduced to its most distinctive word - `N.Bacalso Ave`
   becomes `bacalso`, which matches the OSM name `Natalio Bacalso Avenue`.
   Initials, street types (`Ave`, `St`) and compass words are dropped.
3. The locality is resolved to an **OSM area id** via Nominatim. Only
   `boundary`/`place` relations and ways are accepted, so a landmark that
   happens to share the city's name is not mistaken for the city. Trailing
   components are dropped progressively, because Nominatim ranks a monument
   called "Cebu" above the city for `Cebu City, Cebu`.
4. Overpass returns the nodes the two streets share, restricted to that area.
5. Nodes within 80 m of each other are merged, since a dual-carriageway
   junction is several OSM nodes but one corner to a person.

**Why an area id rather than a bounding box?** Measured on the public instance:
restricting by area answers in ~1.6 s, while the equivalent `[bbox:...]` and
`way(around:...)` queries both time out (HTTP 504).

**When it cannot find the corner** - the streets genuinely never meet, the names
do not match OSM, or Overpass is busy - the request still returns `200` with
matches for the first street and a `note` explaining what happened, rather than
an empty list. Point `OVERPASS_URL` at a mirror if the main instance is
unreliable for you.

## GPS / "Use my location"

The **Use my location (GPS)** button calls the browser's Geolocation API, draws
your position with a circle showing the reported accuracy, and turns into
**Pin my location** so you can save the fix as a pin.

This works on `http://localhost` without any extra setup: geolocation requires a
*secure context*, and browsers treat localhost as one.

It will **not** work over Tailscale by IP (`http://100.x.y.z:3000`), because a
bare IP over http is not a secure context. Use `tailscale serve` to get an
https URL - see [Access over Tailscale](#access-over-tailscale). The page checks
`window.isSecureContext` and tells you rather than failing silently.

Accuracy depends entirely on the device. A phone with GPS is accurate to a few
metres; a desktop without GPS falls back to Wi-Fi or IP lookup and can be off by
hundreds of metres or more, or fail outright. Permission denial, no fix and
timeout each get their own message.

Nothing about your location is sent anywhere unless you choose to save a pin -
the coordinates stay in the browser until then.

## Tests

```bash
npm test
```

Two suites, both offline (no network):

- `test/pluscode.test.mjs` checks `src/pluscode.js` against the official Open
  Location Code vectors, vendored in `test/data/` from
  [google/open-location-code](https://github.com/google/open-location-code):
  302 encoding cases, 420 decoding cases, 25 validity cases and 19 short-code
  round-trips.
- `test/intersection.test.mjs` covers intersection parsing, street-name
  reduction, node clustering and OSM-to-Overpass area id conversion - including
  that ordinary addresses and Plus Codes are *not* mistaken for corners.
- `test/geojson.test.mjs` covers the export/import round trip, longitude-first
  coordinate order in both directions, property-name and colour aliases, and
  the handling of non-point features and junk input.
- `test/store.test.mjs` runs the SQLite store against a throwaway database:
  CRUD, listing order, 50 overlapping writes, transaction rollback, and reading
  the file back from a second connection.

## Project layout

```
server.js              Express app: middleware, routes, error handler
src/store.js           SQLite persistence (node:sqlite), schema and migration
src/net.js             Interface detection and host binding for Tailscale
src/validate.js        Marker input validation
src/routes/markers.js  Marker CRUD endpoints
src/routes/geocode.js  Nominatim proxy (rate limited + cached) + Plus Code resolution
src/pluscode.js        Open Location Code (Plus Code) encode/decode/shorten/recover
src/intersection.js    "A corner B" parsing, street tokens, node clustering
src/overpass.js        Overpass API client (throttled + cached)
src/geojson.js         GeoJSON export/import, shared by both directions
public/index.html      Page markup and the add/edit dialog
public/css/style.css   Styling
public/js/app.js       Leaflet map, pin rendering, API calls
data/map-pointer.db    Saved pins, SQLite (git-ignored)
test/pluscode.test.mjs Plus Code tests against the official vectors
test/intersection.test.mjs  Intersection parsing tests
test/geojson.test.mjs  Export/import round-trip tests
test/store.test.mjs    SQLite store tests (throwaway database)
test/data/             Official OLC test vectors (Apache-2.0)
```

## About the OpenStreetMap APIs

Geocoding calls go through the Express server rather than straight from the browser,
because Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
requires an identifying `User-Agent` and allows at most one request per second. The
proxy in `src/routes/geocode.js` sets that header, queues outbound requests to stay
under the rate limit, and caches responses for five minutes.

Set your own identifier before deploying anywhere public:

```bash
NOMINATIM_USER_AGENT="MyApp/1.0 (you@example.com)" npm start
```

Intersection queries additionally use the
[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), through
`src/overpass.js`, which is likewise serialized (one call per 2 s) and caches
results for 10 minutes. Override the endpoint with `OVERPASS_URL`.

For heavier use, run your own Nominatim and Overpass instances or use a
commercial provider, and note the
[OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
for the map tiles themselves.

## Notes

- Import bodies are capped at 5 MB (roughly 25,000 pins). Raise the
  `express.json` limit in `server.js` if you need more.
- `node:sqlite` is still marked experimental in Node, though it is stable in
  Node 24 and needs no flag. If a future Node changes the API, `src/store.js` is
  the only file that touches it.
- One process owns the database. That is the intended shape for a personal app;
  for several processes, move to Postgres - the routes only depend on the
  `store` interface, so `src/store.js` is the only file to replace.
- There is no authentication by default. See
  [Locking it to you](#locking-it-to-you) above.
