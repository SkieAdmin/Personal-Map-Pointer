import path from 'node:path';
import express from 'express';
import morgan from 'morgan';
import markersRouter from './src/routes/markers.js';
import geocodeRouter from './src/routes/geocode.js';
import { closeStore, databaseFile, migration } from './src/store.js';
import { resolveHost, startupUrls, tailscaleAddresses } from './src/net.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Default to every interface so the app is reachable over Tailscale without
// extra setup. HOST=tailscale restricts it to the tailnet only.
let binding;
try {
  binding = resolveHost(process.env.HOST);
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

app.use(morgan('dev'));
// A GeoJSON upload is the one legitimately large body, and files served as
// application/geo+json must parse too.
app.use(express.json({
  limit: '5mb',
  type: ['application/json', 'application/geo+json', 'application/*+json'],
}));
app.use(express.urlencoded({ extended: true }));

/**
 * Optional allowlist of Tailscale identities.
 *
 * `tailscale serve` sets Tailscale-User-Login on proxied requests and strips
 * any the client supplied, so this is a real check *only* behind that proxy.
 * If the port itself is reachable, the header can be forged - which is why the
 * banner warns when this is enabled without binding to localhost.
 */
const allowedUsers = (process.env.ALLOWED_TAILSCALE_USERS ?? '')
  .split(',')
  .map((user) => user.trim().toLowerCase())
  .filter(Boolean);

if (allowedUsers.length > 0) {
  app.use((req, res, next) => {
    const user = (req.get('Tailscale-User-Login') ?? '').toLowerCase();
    if (user && allowedUsers.includes(user)) return next();

    res.status(403).json({ error: 'Not permitted for this Tailscale identity.' });
  });
}

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), storage: 'sqlite' });
});

app.use('/api/markers', markersRouter);
app.use('/api/geocode', geocodeRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint.' });
});

// Malformed JSON from express.json() lands here with a 400 already set.
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);

  // Upstream outages carry a message worth showing; anything else stays opaque.
  const safe = status < 500 || err.expose === true;
  res.status(status).json({ error: safe ? err.message : 'Internal server error.' });
});

const server = app.listen(PORT, binding.host, () => {
  console.log('\n  Map Pointer');
  console.log(`  pins: ${databaseFile}`);

  if (migration) {
    console.log(`  migrated ${migration.count} pin(s) from markers.json into SQLite`);
  }

  console.log('');
  for (const { url, note } of startupUrls(PORT, binding)) {
    console.log(`  ${url}${note ? `   ${note}` : ''}`);
  }

  if (binding.mode === 'tailscale') {
    console.log(`\n  bound to the tailnet only (${binding.interface}) - not reachable from other networks`);
  }

  if (tailscaleAddresses().length > 0) {
    console.log('\n  For https (and so a working GPS button) over Tailscale:');
    console.log(`    tailscale serve --bg ${PORT}`);
    console.log('    tailscale serve status      # shows the https://<machine>.<tailnet>.ts.net URL');
  }

  if (allowedUsers.length > 0) {
    console.log(`\n  Tailscale identity allowlist active (${allowedUsers.length} user(s))`);
    if (binding.mode !== 'localhost') {
      console.log('    WARNING: only enforced behind "tailscale serve". Port ' + PORT
        + ' is reachable directly, so the identity header can be forged.');
      console.log('    Run with HOST=localhost so tailscale serve is the only way in.');
    }
  }

  console.log('');
});

// Checkpoint the WAL and close cleanly, so no .db-wal is left behind.
function shutdown(signal) {
  console.log(`\n  ${signal} - closing database`);
  server.close(() => {
    closeStore();
    process.exit(0);
  });
  // Do not hang forever if a connection is held open.
  setTimeout(() => {
    closeStore();
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
