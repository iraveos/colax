import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { target: 'es2022' },
  // Relative asset URLs. The packaged app loads over file://, where an
  // absolute /assets/... path resolves to the filesystem root and 404s —
  // which is the black window: the window opens, the HTML loads, and every
  // script and stylesheet 404s silently. './' works identically under vite dev
  // and the static preview server, so this costs the web builds nothing.
  base: './',
});