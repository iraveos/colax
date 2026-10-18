import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChannel,
  channelSeedFromFolder,
  channelTagFilter,
  createChannel,
  createFolder,
  normaliseFolders,
  parentFolderFor,
  type SidebarEntry,
} from '../src/vault/channels.ts';
import { DEFAULT_PREFERENCES, normalisePreferences } from '../src/vault/storage.ts';
import { emptyItem } from '../src/vault/types.ts';

/**
 * Folder tags and how they narrow a channel.
 *
 * The complaint these pin down came in two parts. First: creating a login in a
 * folder filed it under a provider tag picked off its email address, and the
 * folder's own tags were ignored. Second, and the one the shape below is really
 * about: with every tag read as one OR'd bag, a folder's *main* tag alone
 * satisfied every channel in it, so an "Albion" folder with an EU channel and a
 * West channel listed both servers under each. The main tags are a requirement
 * (a scope applied to every channel) and only the tags a channel adds *beyond*
 * them narrow it — the subtraction matters because a channel created in a
 * folder is seeded with the main tags and would otherwise still match on them.
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

test('main tags are required; only tags beyond them narrow the channel', () => {
  const target = folder();
  // A channel with an extra tag narrows by that tag, inside the folder's scope.
  assert.deepEqual(channelTagFilter({ tagIds: ['tg_own'] }, target), {
    required: ['tg_main'],
    anyOf: ['tg_own'],
  });
  // The seeded shape: a channel created in the folder already carries the main
  // tag, so adding a slice tag leaves [tg_main, tg_own]. The main tag must not
  // count as narrowing, or it satisfies the test on its own.
  assert.deepEqual(channelTagFilter({ tagIds: ['tg_main', 'tg_own'] }, target), {
    required: ['tg_main'],
    anyOf: ['tg_own'],
  });
  // A channel carrying only the main tags lists the folder's whole scope.
  assert.deepEqual(channelTagFilter({ tagIds: ['tg_main'] }, target), {
    required: ['tg_main'],
    anyOf: [],
  });
  // A channel with none narrows by the folder's alternate set instead.
  assert.deepEqual(channelTagFilter({ tagIds: [] }, target), {
    required: ['tg_main'],
    anyOf: ['tg_alt'],
  });
  // Outside a folder there is nothing to require.
  assert.deepEqual(channelTagFilter({ tagIds: ['tg_own'] }, null), { required: [], anyOf: ['tg_own'] });
});

test('a channel inside a folder needs the folder tag and one of its own', () => {
  const target = folder();
  const items = [
    emptyItem('a', 1),
    { ...emptyItem('b', 1), tags: ['tg_alt'] },
    { ...emptyItem('c', 1), tags: ['tg_main'] },
    { ...emptyItem('d', 1), tags: ['tg_main', 'tg_alt'] },
    { ...emptyItem('e', 1), tags: ['tg_nothing'] },
  ];
  const untyped = createChannel('Everything', { tagIds: [] });
  const listed = applyChannel(untyped, items, 180, target).map((item) => item.id);
  // 'b' has the alternate tag but not the folder's main one, so it is not in the
  // folder at all; 'c' is in the folder but carries nothing that narrows it.
  assert.deepEqual(listed, ['d'], 'the folder tag scopes, the alternate tag narrows');
});

test('an EU channel and a West channel never list each other’s logins', () => {
  // The reported case: Albion folder, main tag albion, a channel per server.
  const albion = createFolder('Albion', { id: 'fd_al', tagIds: ['tg_albion'] });
  const eu = createChannel('EU', { tagIds: ['tg_eu'] });
  const west = createChannel('West', { tagIds: ['tg_west'] });
  const items = [
    { ...emptyItem('eu1', 1), tags: ['tg_albion', 'tg_eu'] },
    { ...emptyItem('west1', 1), tags: ['tg_albion', 'tg_west'] },
    // A login the EU channel's tag would otherwise drag into the Albion folder.
    { ...emptyItem('stray', 1), tags: ['tg_eu'] },
  ];
  assert.deepEqual(applyChannel(eu, items, 180, albion).map((item) => item.id), ['eu1']);
  assert.deepEqual(applyChannel(west, items, 180, albion).map((item) => item.id), ['west1']);
});

test('a channel seeded from the folder still narrows once a slice tag is added', () => {
  // The workflow as the editor performs it: "new channel in this folder" copies
  // the folder's main tag, then the user ticks the server tag on top. Before the
  // subtraction the copied "albion" matched on its own and the EU channel listed
  // the West logins anyway.
  const albion = createFolder('Albion', { id: 'fd_al', tagIds: ['tg_albion'] });
  const eu = createChannel('EU', { ...channelSeedFromFolder(albion), tagIds: ['tg_albion', 'tg_eu'] });
  const west = createChannel('West', { ...channelSeedFromFolder(albion), tagIds: ['tg_albion', 'tg_west'] });
  const items = [
    { ...emptyItem('eu1', 1), tags: ['tg_albion', 'tg_eu'] },
    { ...emptyItem('west1', 1), tags: ['tg_albion', 'tg_west'] },
  ];
  assert.deepEqual(applyChannel(eu, items, 180, albion).map((item) => item.id), ['eu1']);
  assert.deepEqual(applyChannel(west, items, 180, albion).map((item) => item.id), ['west1']);
});

test('a channel’s parent folder is found from the sidebar tree', () => {
  const albion = createFolder('Albion', { id: 'fd_al', tagIds: ['tg_albion'] });
  const other = createFolder('Other', { id: 'fd_other' });
  const sidebar: SidebarEntry[] = [
    { kind: 'channel', id: 'all' },
    { kind: 'folder', id: 'fd_al', children: [{ kind: 'channel', id: 'ch_eu' }] },
    { kind: 'folder', id: 'fd_other', children: [{ kind: 'channel', id: 'ch_x' }] },
  ];
  assert.equal(parentFolderFor(sidebar, [albion, other], 'ch_eu')?.id, 'fd_al');
  // A channel at the root has no parent to scope it by.
  assert.equal(parentFolderFor(sidebar, [albion, other], 'all'), undefined);
  // A folder id with no stored folder returns nothing rather than throwing.
  assert.equal(parentFolderFor(sidebar, [other], 'ch_eu'), undefined);
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
