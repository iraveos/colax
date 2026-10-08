import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePreferences, DEFAULT_PREFERENCES, MAX_DOCK_SLOTS } from '../src/vault/storage.ts';
import { normaliseItem, emptyItem } from '../src/vault/types.ts';

/** A mutable copy of the defaults, so a test can corrupt one field. */
const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;

test('dock slots default to the four views plus inbox', () => {
  const out = normalisePreferences(base());
  assert.deepEqual(
    out.dockSlots.map((slot) => `${slot.kind}:${slot.ref || slot.kind}:${slot.key}`),
    ['view:animated:1', 'view:carousel:2', 'view:basic:3', 'view:grid:4', 'inbox:inbox:5'],
  );
});

test('an unknown kind is dropped, not kept', () => {
  const stored = base();
  stored.dockSlots = [
    { kind: 'view', ref: 'animated', key: '1' },
    { kind: 'teleport', ref: 'mars', key: '2' },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.dockSlots.length, 1);
  assert.equal(out.dockSlots[0]?.ref, 'animated');
});

test('an unknown view ref is dropped', () => {
  const stored = base();
  stored.dockSlots = [{ kind: 'view', ref: 'coverflow', key: '1' }];
  const out = normalisePreferences(stored);
  assert.deepEqual(
    out.dockSlots.map((slot) => slot.ref),
    ['animated', 'carousel', 'basic', 'grid', ''],
  );
});

test('duplicate keys fall back without colliding', () => {
  const stored = base();
  stored.dockSlots = [
    { kind: 'view', ref: 'animated', key: 'q' },
    { kind: 'view', ref: 'carousel', key: 'Q' },
    { kind: 'view', ref: 'basic', key: '' },
  ];
  const out = normalisePreferences(stored);
  const keys = out.dockSlots.map((slot) => slot.key.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'no two slots share a key');
  assert.equal(out.dockSlots[0]?.key, 'q');
});

test('slots cap at MAX_DOCK_SLOTS', () => {
  const stored = base();
  stored.dockSlots = Array.from({ length: MAX_DOCK_SLOTS + 4 }, (_, i) => ({
    kind: 'channel',
    ref: `c${i}`,
    key: String(i),
  }));
  const out = normalisePreferences(stored);
  assert.ok(out.dockSlots.length <= MAX_DOCK_SLOTS);
});

test('only one inbox survives', () => {
  const stored = base();
  stored.dockSlots = [
    { kind: 'inbox', ref: '', key: '1' },
    { kind: 'inbox', ref: '', key: '2' },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.dockSlots.filter((slot) => slot.kind === 'inbox').length, 1);
});

test('labels cap at 24 chars and icons to safe schemes', () => {
  const stored = base();
  stored.dockSlots = [
    { kind: 'view', ref: 'animated', key: '1', label: 'x'.repeat(100), icon: 'javascript:alert(1)' },
    { kind: 'view', ref: 'carousel', key: '2', icon: 'https://example.com/i.png' },
  ];
  const out = normalisePreferences(stored);
  assert.equal(out.dockSlots[0]?.label?.length, 24);
  assert.equal(out.dockSlots[0]?.icon, undefined);
  assert.equal(out.dockSlots[1]?.icon, 'https://example.com/i.png');
});

test('an empty slot list restores defaults rather than hiding the bar', () => {
  const stored = base();
  stored.dockSlots = [];
  const out = normalisePreferences(stored);
  assert.ok(out.dockSlots.length > 0);
});

test('folder and login kinds survive with refs', () => {
  const stored = base();
  stored.dockSlots = [
    { kind: 'folder', ref: 'f1', key: 'a' },
    { kind: 'login', ref: 'i1', key: 'b' },
    { kind: 'channel', ref: '', key: 'c' },
  ];
  const out = normalisePreferences(stored);
  assert.deepEqual(
    out.dockSlots.map((slot) => slot.kind),
    ['folder', 'login'],
  );
});

test('dock placement clamps onto the screen', () => {
  // A bad edge falls back; each axis clamps independently, so a hand-edited
  // record can never strand the bar where no pointer reaches it.
  const stored = base();
  stored.dockPos = { edge: 'sideways', fx: 99, fy: -4 };
  assert.deepEqual(normalisePreferences(stored).dockPos, { edge: 'bottom', fx: 0.94, fy: 0.06 });
  const left = base();
  left.dockPos = { edge: 'left', fx: 0.06, fy: 0.5 };
  assert.deepEqual(normalisePreferences(left).dockPos, { edge: 'left', fx: 0.06, fy: 0.5 });
  const absent = base();
  delete absent.dockPos;
  assert.deepEqual(normalisePreferences(absent).dockPos, { edge: 'bottom', fx: 0.5, fy: 0.94 });
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
