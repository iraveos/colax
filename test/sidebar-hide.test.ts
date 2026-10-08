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
    hiddenChannels: ['weak', 42, '', 'weak', null],
    showNewChannelButton: false,
    showCompactButton: 0,
  } as never);
  assert.deepEqual(out.hiddenChannels, ['weak']);
  assert.equal(out.showNewChannelButton, false);
  assert.equal(out.showCompactButton, false);
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
