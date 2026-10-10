import test from 'node:test';
import assert from 'node:assert/strict';
import { freeDockSpot, normalisePreferences, DEFAULT_PREFERENCES, MAX_DOCKS, MAX_DOCK_SLOTS } from '../src/vault/storage.ts';
import { normaliseItem, emptyItem } from '../src/vault/types.ts';

/** A mutable copy of the defaults, so a test can corrupt one field. */
const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;

const firstSlots = (stored: Record<string, unknown>) => normalisePreferences(stored).docks[0]?.slots ?? [];

test('dock slots default to the four views plus inbox', () => {
  const out = normalisePreferences(base());
  assert.equal(out.docks.length, 1);
  assert.equal(out.docks[0]?.enabled, true);
  assert.deepEqual(
    firstSlots(base()).map((slot) => `${slot.kind}:${slot.ref || slot.kind}:${slot.key}`),
    ['view:animated:1', 'view:carousel:2', 'view:basic:3', 'view:grid:4', 'inbox:inbox:5'],
  );
});

test('an unknown kind is dropped, not kept', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: [
        { kind: 'view', ref: 'animated', key: '1' },
        { kind: 'teleport', ref: 'mars', key: '2' },
      ],
    },
  ];
  const out = firstSlots(stored);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.ref, 'animated');
});

test('an unknown view ref is dropped', () => {
  const stored = base();
  stored.docks = [{ id: 'main', enabled: true, pos: { edge: 'bottom', fx: 0.5, fy: 0.94 }, slots: [{ kind: 'view', ref: 'coverflow', key: '1' }] }];
  const out = normalisePreferences(stored);
  assert.deepEqual(
    out.docks[0]?.slots.map((slot) => slot.ref),
    ['animated', 'carousel', 'basic', 'grid', ''],
  );
});

test('duplicate keys fall back without colliding', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: [
        { kind: 'view', ref: 'animated', key: 'q' },
        { kind: 'view', ref: 'carousel', key: 'Q' },
        { kind: 'view', ref: 'basic', key: '' },
      ],
    },
  ];
  const keys = firstSlots(stored).map((slot) => slot.key.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'no two slots share a key');
  assert.equal(firstSlots(stored)[0]?.key, 'q');
});

test('slots cap at MAX_DOCK_SLOTS', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: Array.from({ length: MAX_DOCK_SLOTS + 4 }, (_, i) => ({
        kind: 'channel',
        ref: `c${i}`,
        key: String(i),
      })),
    },
  ];
  assert.ok(firstSlots(stored).length <= MAX_DOCK_SLOTS);
});

test('only one inbox survives', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: [
        { kind: 'inbox', ref: '', key: '1' },
        { kind: 'inbox', ref: '', key: '2' },
      ],
    },
  ];
  assert.equal(firstSlots(stored).filter((slot) => slot.kind === 'inbox').length, 1);
});

test('labels cap at 24 chars and icons to safe schemes', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: [
        { kind: 'view', ref: 'animated', key: '1', label: 'x'.repeat(100), icon: 'javascript:alert(1)' },
        { kind: 'view', ref: 'carousel', key: '2', icon: 'https://example.com/i.png' },
      ],
    },
  ];
  const out = firstSlots(stored);
  assert.equal(out[0]?.label?.length, 24);
  assert.equal(out[0]?.icon, undefined);
  assert.equal(out[1]?.icon, 'https://example.com/i.png');
});

test('an empty slot list restores defaults rather than hiding the bar', () => {
  const stored = base();
  stored.docks = [{ id: 'main', enabled: true, pos: { edge: 'bottom', fx: 0.5, fy: 0.94 }, slots: [] }];
  assert.ok(firstSlots(stored).length > 0);
});

test('folder and login kinds survive with refs', () => {
  const stored = base();
  stored.docks = [
    {
      id: 'main',
      enabled: true,
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      slots: [
        { kind: 'folder', ref: 'f1', key: 'a' },
        { kind: 'login', ref: 'i1', key: 'b' },
        { kind: 'channel', ref: '', key: 'c' },
      ],
    },
  ];
  assert.deepEqual(
    firstSlots(stored).map((slot) => slot.kind),
    ['folder', 'login'],
  );
});

test('dock placement clamps onto the screen', () => {
  // A bad edge falls back; each axis clamps independently, so a hand-edited
  // record can never strand the bar where no pointer reaches it.
  const posOf = (pos: unknown) =>
    normalisePreferences({ ...base(), docks: [{ id: 'main', enabled: true, pos, slots: [] }] } as never).docks[0]?.pos;
  assert.deepEqual(posOf({ edge: 'sideways', fx: 99, fy: -4 }), { edge: 'bottom', fx: 0.94, fy: 0.06 });
  assert.deepEqual(posOf({ edge: 'left', fx: 0.06, fy: 0.5 }), { edge: 'left', fx: 0.06, fy: 0.5 });
});

test('a legacy single bar migrates into docks', () => {
  const stored = base();
  delete stored.docks;
  stored.dockEnabled = false;
  stored.dockSlots = [{ kind: 'view', ref: 'grid', key: 'g' }];
  stored.dockPos = { edge: 'left', fx: 0.06, fy: 0.5 };
  const out = normalisePreferences(stored);
  assert.equal(out.docks.length, 1);
  assert.equal(out.docks[0]?.enabled, false);
  assert.deepEqual(out.docks[0]?.pos, { edge: 'left', fx: 0.06, fy: 0.5 });
  assert.deepEqual(out.docks[0]?.slots.map((slot) => slot.ref), ['grid']);
  assert.equal((out as unknown as Record<string, unknown>).dockSlots, undefined);
});

test('fresh docks spawn away from settled bars', () => {
  const at = (fx: number) => ({ pos: { edge: 'bottom', fx, fy: 0.94 } });
  assert.equal(freeDockSpot([]).fx, 0.5);
  assert.equal(freeDockSpot([at(0.5)]).fx, 0.3);
  assert.equal(freeDockSpot([at(0.5), at(0.3), at(0.7), at(0.15), at(0.85)]).fx, 0.5);
});

test('several docks survive, capped at MAX_DOCKS', () => {
  const stored = base();
  stored.docks = Array.from({ length: MAX_DOCKS + 2 }, (_, i) => ({
    id: `dock_${i}`,
    enabled: i !== 1,
    pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
    slots: [{ kind: 'view', ref: 'grid', key: `${i}` }],
  }));
  const out = normalisePreferences(stored);
  assert.ok(out.docks.length <= MAX_DOCKS);
  assert.equal(out.docks[1]?.enabled, false);
});

test('a legacy single gmail object migrates into accounts', () => {
  const stored = base();
  stored.gmail = { enabled: true, address: 'me@gmail.com', appPassword: 'xxxx', refreshSeconds: 120 };
  const out = normalisePreferences(stored);
  assert.equal(out.gmailAccounts.length, 1);
  assert.equal(out.gmailAccounts[0]?.address, 'me@gmail.com');
  assert.equal(out.gmailAccounts[0]?.refreshSeconds, 120);
  assert.equal(out.gmailAccounts[0]?.enabled, true);
});

test('retired cadences migrate onto the nearest offered choice', () => {
  const stored = base();
  stored.gmailAccounts = [
    { id: 'a', address: 'a@gmail.com', appPassword: 'x', enabled: true, refreshSeconds: 2 },
    { id: 'b', address: 'b@gmail.com', appPassword: 'y', enabled: true, refreshSeconds: 10 },
    { id: 'c', address: 'c@gmail.com', appPassword: 'z', enabled: true, refreshSeconds: 15 },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.gmailAccounts[0]?.refreshSeconds, 5);
  assert.equal(out.gmailAccounts[1]?.refreshSeconds, 30);
  assert.equal(out.gmailAccounts[2]?.refreshSeconds, 30);
});

test('offered cadences (including 5s, 30s and Off) pass through untouched', () => {
  const stored = base();
  stored.gmailAccounts = [
    { id: 'a', address: 'a@gmail.com', appPassword: 'x', enabled: true, refreshSeconds: 5 },
    { id: 'b', address: 'b@gmail.com', appPassword: 'y', enabled: true, refreshSeconds: 30 },
    { id: 'c', address: 'c@gmail.com', appPassword: 'z', enabled: true, refreshSeconds: 0 },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.gmailAccounts[0]?.refreshSeconds, 5);
  assert.equal(out.gmailAccounts[1]?.refreshSeconds, 30);
  assert.equal(out.gmailAccounts[2]?.refreshSeconds, 0);
});

test('chrome visibility switches default to shown, never hidden by absence', () => {
  const out = normalisePreferences({});
  assert.equal(out.maskEmails, true);
  assert.equal(normalisePreferences({ maskEmails: false }).maskEmails, false);
  assert.equal(out.showNewLoginButton, true);
  assert.equal(out.showBulkAddButton, true);
  assert.equal(out.showSettingsButton, true);
  assert.equal(out.showHideSidebarButton, true);
  const hidden = normalisePreferences({
    showNewLoginButton: false,
    showBulkAddButton: false,
    showSettingsButton: false,
    showHideSidebarButton: false,
  });
  assert.equal(hidden.showNewLoginButton, false);
  assert.equal(hidden.showBulkAddButton, false);
  assert.equal(hidden.showSettingsButton, false);
  assert.equal(hidden.showHideSidebarButton, false);
});

test('duplicate account addresses collapse to one', () => {
  const stored = base();
  stored.gmailAccounts = [
    { id: 'a', address: 'ME@gmail.com', appPassword: 'x', enabled: true, refreshSeconds: 5 },
    { id: 'b', address: 'me@gmail.com', appPassword: 'y', enabled: true, refreshSeconds: 5 },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.gmailAccounts.length, 1);
});

test('logins show mail unless explicitly opted out', () => {
  assert.equal(normaliseItem({ ...emptyItem('x', 1000) }).showMail, true);
  assert.equal(normaliseItem({ ...emptyItem('x', 1000), showMail: false }).showMail, false);
});
