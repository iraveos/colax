/**
 * Copies the built Windows installer beside the repo root.
 *
 * electron-builder writes into release/ by config; the ask is that the .exe
 * is also visible in the main folder after setup, so copy (not move) the
 * newest `Colax Setup *.exe` up one level. The binary stays gitignored —
 * this changes where you can find it, not what is versioned.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const release = join(root, 'release');

if (!existsSync(release)) {
  console.log('copy-installer: no release/ dir, nothing to copy');
  process.exit(0);
}

const setups = readdirSync(release)
  .filter((name) => /^colax setup .*\.exe$/i.test(name))
  .map((name) => ({ name, mtime: statSync(join(release, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (setups.length === 0) {
  console.log('copy-installer: no installer found in release/');
  process.exit(0);
}

const newest = setups[0].name;
copyFileSync(join(release, newest), join(root, newest));
console.log(`copy-installer: ${newest} -> main folder`);
