import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The rendering path is not a memory setting.
 *
 * A previous build turned the GPU process off in the name of saving memory —
 * `disable-gpu`, `disable-gpu-compositing`, `force-gpu-mem-available-mb=0` —
 * and it worked on every readout the project had: the window loaded, the
 * process tree looked healthy, and the reported figure dropped by ~80 MB,
 * because the GPU process alone holds that much. The window was also a flat
 * black rectangle: the page was there, its pixels were not. `--render-check`
 * eventually showed it as 4 distinct colours on screen against 2088 with the
 * GPU path, which is the difference between a UI and a blank screen.
 *
 * These switches are therefore banned by test rather than by comment. A unit
 * test cannot see a window, so it checks the thing that can be checked cheaply
 * and deterministically: that the code never passes them. Pixel verification is
 * the other half, and it is a command rather than an assertion — see
 * `npm run check:render`.
 */

const source = readFileSync(
  fileURLToPath(new URL('../electron/main.ts', import.meta.url)),
  'utf8',
);

/** Matches an actual switch call, so prose *warning* about these does not count. */
function passesSwitch(name: string): boolean {
  return new RegExp(`appendSwitch\\(\\s*['"\`]${name}['"\`]`).test(source);
}

test('switches that blank the window are never passed', () => {
  for (const banned of ['disable-gpu', 'disable-gpu-compositing', 'force-gpu-mem-available-mb', 'in-process-gpu']) {
    assert.equal(
      passesSwitch(banned),
      false,
      `--${banned} leaves a window that loads and paints nothing; verify with npm run check:render before re-adding`,
    );
  }
});

test('the quiet, safe savings are still applied', () => {
  // These cost nothing visually — they are services an offline vault never uses
  // — so they carry the memory work that survived the black-window incident.
  for (const safe of [
    'SpareRendererForSitePerProcess',
    'AudioServiceOutOfProcess',
    'enable-low-end-device-mode',
    'disable-background-networking',
    'disable-component-update',
  ]) {
    assert.ok(
      source.includes(safe),
      `${safe} is part of the reviewed memory set and should not be dropped silently`,
    );
  }
});

test('the pixel check that caught this is still reachable', () => {
  // The diagnostic is the only thing here that can tell a painted window from a
  // blank one, so its absence is itself a regression.
  assert.ok(source.includes('--render-check'), 'the render check must stay shipped');
  assert.ok(source.includes('capturePage'), 'the render check must keep capturing real pixels');
});
