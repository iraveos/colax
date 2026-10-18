import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePreferences } from '../src/vault/storage.ts';
import { emptyItem, normaliseItem } from '../src/vault/types.ts';

test('hidden channels default to visible, junk ids are dropped', () => {
  const fresh = normalisePreferences({});
  assert.deepEqual(fresh.hiddenChannels, []);
  assert.equal(fresh.showNewChannelButton, true);
  assert.equal(fresh.showCompactButton, true);
  const out = normalisePreferences({
    hiddenChannels: ['ch_work', 42, '', 'ch_work', null],
    showNewChannelButton: false,
    showCompactButton: 0,
  } as never);
  assert.deepEqual(out.hiddenChannels, ['ch_work']);
  assert.equal(out.showNewChannelButton, false);
  assert.equal(out.showCompactButton, false);
  // The three rows that became tabs of All logins are swept out: a hide entry
  // for a channel that no longer exists is a row in Settings that does nothing.
  assert.deepEqual(normalisePreferences({ hiddenChannels: ['favorites', 'weak'] } as never).hiddenChannels, []);
});

test('hiding a built-in channel survives the sweep', () => {
  // Built-ins can be hidden from the rail now; the sweep only retires the ids
  // of rows that became tabs, never the surviving built-ins.
  const kept = normalisePreferences({
    hiddenChannels: ['all', 'dashboard', 'mail', 'history'],
  } as never);
  assert.deepEqual(kept.hiddenChannels, ['all', 'dashboard', 'mail', 'history']);
});

test('the sidebar shows unless explicitly hidden', () => {
  assert.equal(normalisePreferences({}).showSidebar, true);
  assert.equal(normalisePreferences({ showSidebar: false } as never).showSidebar, false);
});

test('logins default to automatic message filtering', () => {
  assert.equal(emptyItem('x').mailFilter, 'auto');
  assert.equal(normaliseItem({ id: 'x' }).mailFilter, 'auto');
  assert.equal(normaliseItem({ id: 'x', mailFilter: 'matched' }).mailFilter, 'matched');
  assert.equal(normaliseItem({ id: 'x', mailFilter: 'recent' }).mailFilter, 'recent');
  assert.equal(normaliseItem({ id: 'x', mailFilter: 'everything' } as never).mailFilter, 'auto');
});
