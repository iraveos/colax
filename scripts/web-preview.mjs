/**
 * Serves the built web app (dist/) for the browser launcher.
 *
 * Zero dependencies on purpose: `optimized web colax.bat` must work on a
 * machine that has Node and nothing else — no node_modules, no vite. The app
 * cannot run from file:// (ES-module fetches are blocked by CORS on an opaque
 * origin, which is why vite.config.ts sets base './'), so something has to
 * speak HTTP. That is this file.
 *
 * Behaviour:
 *  - serves dist/ on 127.0.0.1:4173 with the handful of MIME types the build
 *    actually emits;
 *  - opens the default browser once listening;
 *  - if the port is already serving (a second double-click), opens the browser
 *    again and exits — one server per machine, not one per launch.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const port = 4173;
const url = `http://127.0.0.1:${port}/`;

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No build found at ${dist}. Run "npm run build" first.`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Opens a URL in the OS's default browser. Windows first; a failed spawn is
    not worth failing the server over — the URL is printed either way. */
function openBrowser(target) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

/** Resolves a request path inside dist/, or null when it escapes or is gone.
    Everything that is not a real file falls through to index.html: the app is
    one page, and a hash route is not a path. */
function resolveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const full = join(dist, rel);
  if (full !== dist && !full.startsWith(dist + sep)) return null;
  try {
    const stat = statSync(full);
    if (stat.isFile()) return full;
  } catch {
    // Falls through to the single-page fallback.
  }
  return join(dist, 'index.html');
}

const server = createServer((request, response) => {
  const file = resolveFile(new URL(request.url ?? '/', url).pathname);
  try {
    const body = readFileSync(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found.');
  }
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    // Already serving (a second double-click): the page is one browser
    // shortcut away, and a second copy of the server would only fight for
    // the port.
    console.log(`Colax web is already being served — opening ${url}`);
    openBrowser(url);
    process.exit(0);
  }
  console.error(`Could not start the web server (${error?.message ?? 'unknown'}).`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Colax (web) is running at ${url}`);
  console.log('Keep this window open while using it. Close it to stop.');
  openBrowser(url);
});
