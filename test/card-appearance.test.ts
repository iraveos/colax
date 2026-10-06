import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, normalisePreferences } from '../src/vault/storage.ts';

/** A mutable copy of the defaults, so a test can corrupt one field. */
const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;

test('cardSize defaults exist for all three views', () => {
  const out = normalisePreferences(base());
  assert.deepEqual(Object.keys(out.cardSize).sort(), ['animated', 'basic', 'carousel']);
});

test('a missing cardSize is filled with defaults, not left undefined', () => {
  const stored = base();
  delete stored.cardSize;
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.carousel.width, DEFAULT_PREFERENCES.cardSize.carousel.width);
  assert.equal(out.cardSize.animated.width, DEFAULT_PREFERENCES.cardSize.animated.width);
});

test('a stored card size is preserved', () => {
  const stored = base();
  stored.cardSize = { carousel: { scale: 1.2, width: 420, minHeight: 180, aspect: 1.5, surface: 0.5, radius: 8 } };
  const out = normalisePreferences(stored);
  assert.deepEqual(out.cardSize.carousel, {
    scale: 1.2,
    width: 420,
    minHeight: 180,
    aspect: 1.5,
    surface: 0.5,
    radius: 8,
  });
});

test('out-of-range card values are clamped rather than accepted', () => {
  const stored = base();
  stored.cardSize = {
    carousel: { scale: 99, width: 99999, minHeight: 99999, aspect: -4, surface: 7, radius: 900 },
  };
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.carousel.scale, 1.6);
  assert.equal(out.cardSize.carousel.width, 1200);
  assert.equal(out.cardSize.carousel.minHeight, 480);
  assert.equal(out.cardSize.carousel.aspect, 0.5);
  assert.equal(out.cardSize.carousel.surface, 1);
  assert.equal(out.cardSize.carousel.radius, 48);
});

test('NaN and non-numeric card values fall back to the default', () => {
  const stored = base();
  stored.cardSize = {
    basic: { scale: Number.NaN, width: 'wide', minHeight: 'tall', aspect: null, surface: undefined, radius: {} },
  };
  const out = normalisePreferences(stored);
  const fallback = DEFAULT_PREFERENCES.cardSize.basic;
  assert.equal(out.cardSize.basic.scale, fallback.scale);
  assert.equal(out.cardSize.basic.width, fallback.width);
  assert.equal(out.cardSize.basic.minHeight, fallback.minHeight);
  assert.equal(out.cardSize.basic.aspect, fallback.aspect);
  assert.equal(out.cardSize.basic.surface, fallback.surface);
  assert.equal(out.cardSize.basic.radius, fallback.radius);
});

test('a card size record written before minHeight existed still loads', () => {
  // Every Flow and List card carries a min-height now, so an older vault has to
  // pick up a real default rather than 0 or NaN.
  const stored = base();
  stored.cardSize = { basic: { scale: 1, width: 700 } };
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.basic.minHeight, DEFAULT_PREFERENCES.cardSize.basic.minHeight);
  assert.ok(out.cardSize.basic.minHeight > 0, 'list rows get a real floor, not a collapsed one');
});

test('the legacy global flowCardSize preference is gone', () => {
  // It drove Flow's card width as a percentage of the content column, which
  // contradicted the per-view px cap and made two controls fight over one box.
  assert.equal('flowCardSize' in DEFAULT_PREFERENCES, false);
  const stored = base();
  stored.flowCardSize = 130;
  assert.equal('flowCardSize' in normalisePreferences(stored), false);
});

test('a partially written card record keeps its good fields', () => {
  const stored = base();
  stored.cardSize = { carousel: { width: 300 } };
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.carousel.width, 300, 'the stored field survives');
  assert.equal(out.cardSize.carousel.radius, DEFAULT_PREFERENCES.cardSize.carousel.radius, 'the rest defaults');
});

test('sidebarLabels only accepts the three known modes', () => {
  for (const mode of ['icon', 'name', 'both'] as const) {
    const stored = base();
    stored.sidebarLabels = mode;
    assert.equal(normalisePreferences(stored).sidebarLabels, mode);
  }
  const stored = base();
  stored.sidebarLabels = 'nonsense';
  assert.equal(normalisePreferences(stored).sidebarLabels, 'both');
});

test('sidebarPosition only accepts the four known edges', () => {
  for (const position of ['left', 'right', 'top', 'bottom'] as const) {
    const stored = base();
    stored.sidebarPosition = position;
    assert.equal(normalisePreferences(stored).sidebarPosition, position);
  }
  const stored = base();
  stored.sidebarPosition = 'floating';
  assert.equal(normalisePreferences(stored).sidebarPosition, 'left');
});

test('orbit cards are no longer the old too-small 230px', () => {
  // Regression guard: Orbit was hard-coded to 230 and read as far too small.
  assert.ok(
    DEFAULT_PREFERENCES.cardSize.carousel.width >= 300,
    `orbit width should be at least 300, got ${DEFAULT_PREFERENCES.cardSize.carousel.width}`,
  );
});