import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Baked into the bundle so the running app can say exactly which build it is
// (Settings → Data → App version). Ends the "did the new installer actually
// apply" loop: the stamp names the version and the build time.
const appVersion: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const buildStamp = `${appVersion} · built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { target: 'es2022' },
  define: { __COLAX_BUILD__: JSON.stringify(buildStamp) },
  // Relative asset URLs. The packaged app loads over file://, where an
  // absolute /assets/... path resolves to the filesystem root and 404s —
  // which is the black window: the window opens, the HTML loads, and every
  // script and stylesheet 404s silently. './' works identically under vite dev
  // and the static preview server, so this costs the web builds nothing.
  base: './',
});