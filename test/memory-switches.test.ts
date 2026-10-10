import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The rendering path is not a memory setting.
 *
 * A shipped build set Chromium's GPU memory allowance to zero to save memory,
 * and it worked on every readout the project had: the window loaded, the
 * process tree looked healthy, and the reported figure dropped by ~80 MB. The
 * window was also a flat black rectangle — the page was there, its pixels were
 * not. `--render-check` showed it as 4 distinct colours on screen.
 *
 * Measuring the three suspects one at a time is what identified the culprit:
 * disabling the GPU entirely still painted ~2000 colours, and so did disabling
 * GPU compositing, while `force-gpu-mem-available-mb=0` painted 4. So the GPU
 * switches stay (they carry the saving) and the budget switch is banned by
 * test rather than by comment.
 *
 * A unit test cannot see a window, so it checks what can be checked cheaply and
 * deterministically: that the code never passes the fatal switch, and that the
 * pixel check which caught it is still reachable. Pixel verification itself is
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

test('the switch that blanked the window is never passed', () => {
  // Measured, not assumed: with --force-gpu-mem-available-mb=0 the window
  // painted 4 distinct colours; without it, ~2000.
  assert.equal(
    passesSwitch('force-gpu-mem-available-mb'),
    false,
    'this one leaves a window that loads and paints nothing; verify with npm run check:render before re-adding',
  );
  // Folding the GPU into the browser process is a stability trade, not a
  // memory one, so it is out too.
  assert.equal(passesSwitch('in-process-gpu'), false, 'a GPU fault would take the whole app down with it');
});

test('the GPU switches that carry the saving are still applied, behind the GPU switch', () => {
  // These were the prime suspects and are cleared: each was measured to paint a
  // real UI (~2000 colours) on its own. Dropping them silently would give back
  // ~80 MB for nothing — but they are also the software-rasterization path, so
  // they must stay reachable and must stay conditional. Shipping them
  // unconditionally is what pinned the CPU on every frame; shipping them not at
  // all gives back the memory saving. Both switches, one guard.
  for (const kept of ['disable-gpu', 'disable-gpu-compositing']) {
    assert.equal(passesSwitch(kept), true, `${kept} is verified to render; do not remove it without a measurement`);
  }
  // The guard block carries a long measured comment, so the window is generous.
  assert.ok(
    /if\s*\(!efficiency\.gpu\)[\s\S]{0,2000}?appendSwitch\(\s*['"]disable-gpu['"]/.test(source),
    'the software path must be guarded by the GPU setting, not applied always',
  );
});

test('the low-memory setting no longer drags the rendering path with it', () => {
  // The two are separate trades: caches (maxSavings) and the compositor (gpu).
  // Folding them together is the bug this split fixes — "save memory" silently
  // bought "draw every frame on the processor".
  const guard = source.slice(source.indexOf('if (efficiency.maxSavings)'), source.indexOf('if (!efficiency.gpu)') + 40);
  assert.ok(guard.length > 40, 'both guards must exist, in that order');
  assert.equal(
    /appendSwitch\(\s*['"]disable-gpu/.test(guard.slice(0, guard.indexOf('if (!efficiency.gpu)'))),
    false,
    'low-memory mode must not switch off the GPU by itself',
  );
  assert.ok(source.includes('gpu:'), 'the stored setting must carry the GPU choice');
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
