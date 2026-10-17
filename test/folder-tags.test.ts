import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChannel,
  channelSeedFromFolder,
  createChannel,
  createFolder,
  effectiveChannelTagIds,
  normaliseFolders,
} from '../src/vault/channels.ts';
import { DEFAULT_PREFERENCES, normalisePreferences } from '../src/vault/storage.ts';
import { emptyItem } from '../src/vault/types.ts';

/**
 * Folder tags and their inheritance.
 *
 * The complaint these pin down: creating a login in a folder filed it under a
 * provider tag picked off its email address, and the folder's own tags were
 * ignored. A folder's main tags apply to every channel in it, its alternate
 * tags are the fallback for children with no tags of their own, and a channel
 * inside a folder is narrowed by both.
 */

const folder = (over: Partial<ReturnType<typeof createFolder>> = {}) =>
  createFolder('Work', { id: 'fd_1', tagIds: ['tg_main'], altTagIds: ['tg_alt'], ...over });

test('a folder is created with empty tags, notes and a visible notes button', () => {
  const fresh = createFolder('Work');
  assert.deepEqual(fresh.tagIds, []);
  assert.deepEqual(fresh.altTagIds, []);
  assert.equal(fresh.notes, '');
  assert.equal(fresh.notesHidden, false);
});

test('main tags always apply; alternate tags are only a fallback', () => {
  const target = folder();
  // A channel with its own tags keeps them, plus the folder's main tags.
  assert.deepEqual(effectiveChannelTagIds({ tagIds: ['tg_own'] }, target), ['tg_main', 'tg_own']);
  // A channel with none borrows the folder's alternate set.
  assert.deepEqual(effectiveChannelTagIds({ tagIds: [] }, target), ['tg_main', 'tg_alt']);
  // Outside a folder nothing is inherited.
  assert.deepEqual(effectiveChannelTagIds({ tagIds: ['tg_own'] }, null), ['tg_own']);
});

test('a channel inside a folder is narrowed by the folder tags', () => {
  const target = folder();
  const items = [
    emptyItem('a', 1),
    { ...emptyItem('b', 1), tags: ['tg_alt'] },
    { ...emptyItem('c', 1), tags: ['tg_nothing'] },
  ];
  const untyped = createChannel('Everything', { tagIds: [] });
  const listed = applyChannel(untyped, items, 180, target).map((item) => item.id);
  assert.deepEqual(listed, ['b'], 'only the login carrying the folder tag is in the folder channel');
});

test('a new channel in a folder copies the folder its look and its main tags', () => {
  const target = folder({ icon: 'folder', hue: 44, accent: 'clay' });
  const seed = channelSeedFromFolder(target);
  assert.deepEqual(seed.tagIds, ['tg_main']);
  assert.equal(seed.hue, 44);
  assert.equal(seed.accent, 'clay');
  // 'folder' is a folder-only glyph; a channel must fall back to a real one.
  assert.equal(seed.icon, 'layers');
});

test('stored folders gain the new fields without losing anything', () => {
  const [legacy] = normaliseFolders([
    { id: 'fd_old', name: 'Old', tagIds: ['tg_a', 'tg_a', 7], altTagIds: 'nope', notes: 'hi', notesHidden: true } as never,
  ]);
  assert.deepEqual(legacy?.tagIds, ['tg_a'], 'duplicates and non-strings are dropped');
  assert.deepEqual(legacy?.altTagIds, [], 'a non-list falls back to empty');
  assert.equal(legacy?.notes, 'hi');
  assert.equal(legacy?.notesHidden, true);

  const [missing] = normaliseFolders([{ id: 'fd_bare', name: 'Bare' } as never]);
  assert.deepEqual(missing?.tagIds, []);
  assert.deepEqual(missing?.altTagIds, []);
  assert.equal(missing?.notes, '');
  assert.equal(missing?.notesHidden, false);
});

test('per-workspace drag orders survive a reload, and malformed ones are dropped', () => {
  const prefs = normalisePreferences({
    ...DEFAULT_PREFERENCES,
    manualOrderByScope: { all: ['a', 'b'], 'folder:fd_1': ['c'], broken: 'nope', empty: [] } as never,
  });
  assert.deepEqual(prefs.manualOrderByScope.all, ['a', 'b']);
  assert.deepEqual(prefs.manualOrderByScope['folder:fd_1'], ['c']);
  assert.equal('broken' in prefs.manualOrderByScope, false);
  assert.equal('empty' in prefs.manualOrderByScope, false, 'an empty list means "no order of its own"');
  assert.deepEqual({}, normalisePreferences({ manualOrderByScope: undefined as never }).manualOrderByScope);
});
