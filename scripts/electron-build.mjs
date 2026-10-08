/**
 * Bundles the Electron shell (electron/main.ts, electron/preload.ts).
 *
 * esbuild, not tsc: the shell must be real runnable CJS (package.json is
 * `"type": "module"`, hence the .cjs output), and esbuild is already in the
 * tree via Vite. Type errors are still caught — `npm run typecheck` covers
 * electron/ through tsconfig.node.json.
 *
 * COLAX_APP_VERSION is baked in from package.json so preload.versions() stays
 * synchronous; the alternative is an async IPC round-trip for a string.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron'],
  // The tray icon inlines as a data URL: no file path that differs between dev
  // (repo/public) and packaged (resources/) layouts, and no extraResources entry.
  loader: { '.png': 'dataurl' },
  define: { COLAX_APP_VERSION: JSON.stringify(version) },
  logLevel: 'warning',
};

await build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
console.log(`electron shell bundled (app v${version})`);
