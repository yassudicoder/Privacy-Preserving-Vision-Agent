/*
 * Static file server for the SIH26171 Agent Test Lab.
 *
 * Zero dependencies, loopback only. Node's own http module, nothing installed.
 *
 * WHY A SERVER AND NOT file:// - the extension's optional_host_permissions
 * declare http://localhost/* and http://127.0.0.1/*, and deriveOriginPattern
 * accepts loopback http. A file:// page can be granted neither, so a run there
 * has no path past activeTab and no way to reach a granted origin at all.
 *
 * Outside src/, so the "nothing in the extension bundle imports node:*" rule in
 * tests/architecture/boundaries.test.ts is untouched - that test only walks src.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

const PORT = (() => {
  const flag = process.argv.indexOf('--port');
  const raw = flag !== -1 ? process.argv[flag + 1] : process.env.PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8080;
})();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  // The raster types vision.html needs. Without these the fallback is
  // application/octet-stream: Chrome sniffs and renders the PNG anyway, so the
  // page LOOKS fine while DevTools reports the wrong type - a confusing state
  // to debug a vision failure through.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Map a request path to a file inside ROOT, or null.
 *
 * The resolved path is checked to be under ROOT after normalisation, so
 * `/../../.env` and its encoded variants cannot escape the directory.
 */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

const server = createServer((req, res) => {
  const file = resolvePath(req.url ?? '/');

  if (file === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 outside the test site directory\n');
    return;
  }

  void (async () => {
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        // Never cache. Editing the page and reloading has to show the edit,
        // and a stale bundle during an agent run is impossible to diagnose.
        'cache-control': 'no-store, must-revalidate',
        'content-length': body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 not found\n');
    }
  })();
});

// Loopback only. Binding 0.0.0.0 would publish a page full of decoy PII to the
// local network for no benefit.
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `SIH26171 Agent Test Lab\n` +
      `  http://localhost:${PORT}/\n` +
      `  http://127.0.0.1:${PORT}/\n` +
      `serving ${ROOT}\n` +
      `Ctrl+C to stop.\n`,
  );
});

server.on('error', (err) => {
  const code = /** @type {NodeJS.ErrnoException} */ (err).code;
  if (code === 'EADDRINUSE') {
    process.stderr.write(
      `Port ${PORT} is already in use. Try: node test-site/serve.mjs --port 8081\n`,
    );
    process.exit(1);
  }
  throw err;
});
