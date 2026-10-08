/**
 * `npm run dev:electron`: Vite dev server + Electron, one command.
 *
 * Spawns `vite` itself (via node_modules/vite/bin/vite.js, so no npx/.cmd
 * portability issues), waits for the dev server to answer, bundles the shell
 * once, then opens Electron pointed at it. Renderer edits hot-reload through
 * Vite as usual; shell edits (electron/, preload) need a restart of this
 * command — rebuilding the window chrome live would drop the unlocked vault
 * state on every save, which is worse than a manual restart.
 *
 * Ctrl+C kills the whole tree.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const RENDERER_URL = 'http://localhost:5173';
const children = new Set();

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function killAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});

run(process.execPath, ['node_modules/vite/bin/vite.js']);

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    const res = await fetch(RENDERER_URL);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  if (Date.now() > deadline) {
    console.error('vite dev server did not answer in 60s');
    killAll();
    process.exit(1);
  }
  await sleep(500);
}

const { execSync } = await import('node:child_process');
execSync('node scripts/electron-build.mjs', { stdio: 'inherit' });

const electronBin =
  process.platform === 'win32'
    ? 'node_modules\\.bin\\electron.cmd'
    : 'node_modules/.bin/electron';
run(electronBin, ['.'], { ELECTRON_RENDERER_URL: RENDERER_URL });
