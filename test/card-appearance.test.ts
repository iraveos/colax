import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, mergeListTabs, moveListTab, normalisePreferences } from '../src/vault/storage.ts';

/** A mutable copy of the defaults, so a test can corrupt one field. */
const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;

test('cardSize defaults exist for all views', () => {
  const out = normalisePreferences(base());
  assert.deepEqual(Object.keys(out.cardSize).sort(), ['animated', 'basic', 'grid']);
});

test('the grid view is a real, selectable view', () => {
  const out = normalisePreferences(base());
  assert.equal(out.view, DEFAULT_PREFERENCES.view);

  const grid = base();
  grid.view = 'grid';
  assert.equal(normalisePreferences(grid).view, 'grid');

  // A record written before Grid existed must keep whichever view it actually
  // had rather than being rewritten into something else.
  const older = base();
  older.view = 'animated';
  assert.equal(normalisePreferences(older).view, 'animated');
});

test('a vault saved on the retired Orbit view opens on Flow', () => {
  // Orbit was removed in 1.0.62; its stored view falls back to the default
  // rather than stranding the vault on a view that no longer renders.
  const stored = base();
  stored.view = 'carousel';
  assert.equal(normalisePreferences(stored).view, DEFAULT_PREFERENCES.view);
});

test('a dock slot pointing at the retired Orbit view is dropped', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      slots: [
        { kind: 'view', ref: 'animated', key: '1' },
        { kind: 'view', ref: 'carousel', key: '2' },
        { kind: 'view', ref: 'basic', key: '3' },
      ],
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      enabled: true,
    },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.docks[0]?.slots.some((slot) => slot.ref === 'carousel'), false);
  // The remaining slots keep working, keys renumbered.
  assert.deepEqual(
    out.docks[0]?.slots.map((slot) => `${slot.kind}:${slot.ref}:${slot.key}`),
    ['view:animated:1', 'view:basic:3'],
    'the surviving slots keep the keys their owner learned, without renumbering',
  );
});

test('viewLabels accepts only the three known modes', () => {
  for (const mode of ['icon', 'name', 'both'] as const) {
    const stored = base();
    stored.viewLabels = mode;
    assert.equal(normalisePreferences(stored).viewLabels, mode);
  }
  const bogus = base();
  bogus.viewLabels = 'nonsense';
  assert.equal(normalisePreferences(bogus).viewLabels, 'both');
});

test('viewLabelsByView keeps valid overrides and drops invalid ones', () => {
  const stored = base();
  stored.viewLabelsByView = { grid: 'icon', basic: 'nonsense', animated: 42 };
  const out = normalisePreferences(stored);
  assert.equal(out.viewLabelsByView.grid, 'icon');
  // A bad entry is dropped rather than kept, so the view falls back to the
  // group setting instead of rendering an undefined label mode.
  assert.equal('basic' in out.viewLabelsByView, false);
  assert.equal('animated' in out.viewLabelsByView, false);
});

test('an absent viewLabelsByView becomes an empty object, not undefined', () => {
  const stored = base();
  delete stored.viewLabelsByView;
  const out = normalisePreferences(stored);
  assert.deepEqual(out.viewLabelsByView, {});
});

test('the accent preference survives normalisation', () => {
  // Regression guard: channels used to re-skin from their own accent field and
  // shadow the preference, which is why the picker appeared inert. The
  // preference itself was always fine; this pins that it still round-trips.
  for (const accent of ['slate', 'sage', 'dusk', 'clay'] as const) {
    const stored = base();
    stored.accent = accent;
    assert.equal(normalisePreferences(stored).accent, accent);
  }
});

test('a missing cardSize is filled with defaults, not left undefined', () => {
  const stored = base();
  delete stored.cardSize;
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.basic.width, DEFAULT_PREFERENCES.cardSize.basic.width);
  assert.equal(out.cardSize.animated.width, DEFAULT_PREFERENCES.cardSize.animated.width);
});

test('a stored card size is preserved', () => {
  const stored = base();
  stored.cardSize = { basic: { scale: 1.2, width: 420, minHeight: 180, aspect: 1.5, surface: 0.5, radius: 8 } };
  const out = normalisePreferences(stored);
  assert.deepEqual(out.cardSize.basic, {
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
    basic: { scale: 99, width: 99999, minHeight: 99999, aspect: -4, surface: 7, radius: 900 },
  };
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.basic.scale, 1.6);
  assert.equal(out.cardSize.basic.width, 1200);
  assert.equal(out.cardSize.basic.minHeight, 480);
  assert.equal(out.cardSize.basic.aspect, 0.5);
  assert.equal(out.cardSize.basic.surface, 1);
  assert.equal(out.cardSize.basic.radius, 48);
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

test('the retired showOrbitLabels preference is gone', () => {
  assert.equal('showOrbitLabels' in DEFAULT_PREFERENCES, false);
  const stored = base();
  stored.showOrbitLabels = true;
  assert.equal('showOrbitLabels' in normalisePreferences(stored), false);
});

test('a partially written card record keeps its good fields', () => {
  const stored = base();
  stored.cardSize = { basic: { width: 300 } };
  const out = normalisePreferences(stored);
  assert.equal(out.cardSize.basic.width, 300, 'the stored field survives');
  assert.equal(out.cardSize.basic.radius, DEFAULT_PREFERENCES.cardSize.basic.radius, 'the rest defaults');
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

test('list tabs start with the shipped All-logins strip and nothing else', () => {
  const out = normalisePreferences(base());
  assert.deepEqual(out.listTabs.all, ['tab:all', 'tab:favorites', 'tab:attention', 'tab:weak']);
  assert.equal(Object.keys(out.listTabs).length, 1);
});

test('listTabs keeps known tabs and channels, drops the rest', () => {
  const stored = base();
  const out = normalisePreferences({
    ...stored,
    listTabs: {
      all: ['tab:weak', 'tab:bogus', 'ch_work', 'tab:attention'],
      // A second scope the user has configured: tabs and channels together.
      ch_work: ['tab:favorites', 'gone'],
      'folder:abc': [],
      broken: 'not-a-list',
    },
    channels: [
      { id: 'ch_work' },
      { id: 'ch_mail' },
    ],
  } as unknown as Parameters<typeof normalisePreferences>[0]);

  assert.deepEqual(out.listTabs.all, ['tab:weak', 'ch_work', 'tab:attention']);
  assert.deepEqual(out.listTabs.ch_work, ['tab:favorites']);
  // An explicit empty list survives: hiding a scope's strip is a choice.
  assert.deepEqual(out.listTabs['folder:abc'], []);
  assert.equal('broken' in out.listTabs, false);
});

test('a tab pointing at the synthetic Unassigned row survives normalisation', () => {
  // Unassigned is built on the fly, but it is a real rail row and a real tab
  // target, so it must not be swept out with deleted channels.
  const stored = base();
  const out = normalisePreferences({
    ...stored,
    listTabs: { all: ['tab:all', 'unassigned'], ch_work: ['unassigned', 'tab:weak'] },
    channels: [{ id: 'ch_work' }],
  } as unknown as Parameters<typeof normalisePreferences>[0]);

  assert.deepEqual(out.listTabs.all, ['tab:all', 'unassigned']);
  assert.deepEqual(out.listTabs.ch_work, ['unassigned', 'tab:weak']);
});

test('a tab jump keeps every tab from the strip it came from', () => {
  const source = ['tab:all', 'tab:favorites', 'ch_work', 'ch_mail'];
  // All logins has the shipped four tabs, none of the channel tabs. The jump
  // must not replace them with the destination's own list.
  const merged = mergeListTabs(source, ['tab:all', 'tab:favorites', 'tab:attention', 'tab:weak'], 'ch_work');
  // Every source tab survives; the destination-only ones follow it.
  assert.deepEqual(merged, [...source, 'tab:attention', 'tab:weak']);
  for (const id of source) assert.ok(merged.includes(id), `${id} disappeared`);
  // Every source tab is still there, and the destination-only ones follow.
  assert.deepEqual(
    mergeListTabs(source, ['tab:attention', 'tab:weak'], 'ch_work'),
    ['tab:all', 'tab:favorites', 'ch_work', 'ch_mail', 'tab:attention', 'tab:weak'],
  );
});

test('a tab jump adds the clicked tab and a back-tab once', () => {
  assert.deepEqual(
    mergeListTabs(['ch_work'], ['ch_work'], 'ch_work', 'ch_work'),
    ['ch_work'],
  );
  assert.deepEqual(
    mergeListTabs(['tab:all'], ['tab:all'], 'tab:favorites', 'ch_work'),
    ['tab:all', 'tab:favorites', 'ch_work'],
  );
});

test('a tab jump keeps a destination strip whose order already covers the source', () => {
  // Nothing is missing, so the user's own order is left alone.
  assert.deepEqual(
    mergeListTabs(['tab:all', 'ch_work'], ['ch_work', 'tab:all', 'tab:weak'], 'ch_work'),
    ['ch_work', 'tab:all', 'tab:weak'],
  );
});

test('dragging a tab reorders it before or after the tab it is dropped on', () => {
  const tabs = ['tab:all', 'ch_work', 'tab:favorites', 'ch_mail'];
  // Forward: the target index is read after the dragged tab is removed.
  assert.deepEqual(moveListTab(tabs, 'tab:all', 'tab:favorites', true), ['ch_work', 'tab:favorites', 'tab:all', 'ch_mail']);
  // Backward: dropping on the left half lands before the target.
  assert.deepEqual(moveListTab(tabs, 'ch_mail', 'ch_work', false), ['tab:all', 'ch_mail', 'ch_work', 'tab:favorites']);
  assert.deepEqual(moveListTab(tabs, 'ch_work', 'ch_mail', true), ['tab:all', 'tab:favorites', 'ch_mail', 'ch_work']);
});

test('a drag onto itself or an unknown id never changes the strip', () => {
  const tabs = ['tab:all', 'ch_work'];
  assert.deepEqual(moveListTab(tabs, 'tab:all', 'tab:all', true), tabs);
  assert.deepEqual(moveListTab(tabs, 'tab:all', 'gone', false), tabs);
  assert.deepEqual(moveListTab(tabs, 'gone', 'tab:all', false), tabs);
});

test('a missing listTabs record falls back to the shipped strip', () => {
  const stored = base() as unknown as Record<string, unknown>;
  delete stored.listTabs;
  const out = normalisePreferences(stored as Parameters<typeof normalisePreferences>[0]);
  assert.deepEqual(out.listTabs, DEFAULT_PREFERENCES.listTabs);
});

test('notifications only accepts the three known levels', () => {
  for (const level of ['all', 'errors', 'off'] as const) {
    const stored = base();
    stored.notifications = level;
    assert.equal(normalisePreferences(stored).notifications, level);
  }
  const stored = base();
  stored.notifications = 'sometimes';
  assert.equal(normalisePreferences(stored).notifications, 'all');
});
