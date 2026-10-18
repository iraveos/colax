import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_LOGIN_TABS,
  BUILTIN_CHANNELS,
  applyChannel,
  createChannel,
  normaliseChannels,
  normaliseSidebar,
  sectionTarget,
} from '../src/vault/channels.ts';
import { emptyItem } from '../src/vault/types.ts';

/**
 * Favorites, Needs attention and Weak or reused are tabs of All logins now.
 *
 * The regression these guard is a reload resurrecting them: the shipped rows are
 * still in an older vault's preferences, and normalising must drop them rather
 * than append them beside the tab strip that replaced them.
 */

const base = BUILTIN_CHANNELS[0]!;

test('the four sections are the tabs of one channel', () => {
  assert.deepEqual(
    ALL_LOGIN_TABS.map((tab) => tab.kind),
    ['all', 'favorites', 'attention', 'weak'],
  );
});

test('the merged rows ship no longer as channels of their own', () => {
  const ids = BUILTIN_CHANNELS.map((channel) => channel.id);
  assert.deepEqual(ids, ['all', 'dashboard', 'mail', 'history']);
});

test('a stored copy of a merged row is dropped on load', () => {
  const stored = [
    // What an older vault actually has on disk: the four rows it shipped, plus
    // one of the user's own.
    { ...base },
    { ...base, id: 'favorites', name: 'Favorites', kind: 'favorites' as const },
    { ...base, id: 'attention', name: 'Needs attention', kind: 'attention' as const },
    { ...base, id: 'weak', name: 'Weak or reused', kind: 'weak' as const },
    { ...base, id: 'ch_mine', name: 'Work', kind: 'tags' as const },
  ];

  const channels = normaliseChannels(stored);
  const ids = channels.map((channel) => channel.id);
  assert.ok(ids.includes('all'), 'the main channel survives');
  assert.ok(ids.includes('ch_mine'), 'a channel the user made survives');
  assert.ok(!ids.includes('favorites'), 'Favorites is a tab now');
  assert.ok(!ids.includes('attention'), 'Needs attention is a tab now');
  assert.ok(!ids.includes('weak'), 'Weak or reused is a tab now');
});

test('a channel the user makes with one of those kinds is left alone', () => {
  // The whole point of keeping the kinds: a separate "Favorites" row is still a
  // thing someone can have. Only the shipped ids are retired.
  const mine = createChannel('Starred', { kind: 'favorites' });
  const channels = normaliseChannels([...BUILTIN_CHANNELS, mine]);
  const kept = channels.find((channel) => channel.id === mine.id);
  assert.ok(kept, 'the user-made channel was not swept up with the retired rows');
  assert.equal(kept.kind, 'favorites');
});

test('a sidebar that still points at a retired row loses it', () => {
  const channels = normaliseChannels(BUILTIN_CHANNELS);
  const sidebar = normaliseSidebar(
    [
      { kind: 'channel', id: 'dashboard' },
      { kind: 'channel', id: 'favorites' },
      { kind: 'channel', id: 'weak' },
    ],
    channels,
    [],
  );
  const ids = sidebar.flatMap((entry) => (entry.kind === 'channel' ? [entry.id] : []));
  assert.ok(!ids.includes('favorites'));
  assert.ok(!ids.includes('weak'));
  assert.ok(ids.includes('all'), 'every real channel is still reachable');
});

test('each tab filters the one channel', () => {
  const channels = normaliseChannels(BUILTIN_CHANNELS);
  const all = channels.find((channel) => channel.kind === 'all')!;
  const items = [
    emptyItem('i1', 1),
    { ...emptyItem('i2', 1), favorite: true },
    { ...emptyItem('i3', 1), needsAttention: true },
    { ...emptyItem('i4', 1), password: '123456', passwordUpdatedAt: 1 },
  ];

  const ids = (kind: 'all' | 'favorites' | 'attention' | 'weak') =>
    applyChannel({ ...all, kind }, items, 180).map((item) => item.id);

  assert.deepEqual(ids('all'), ['i1', 'i2', 'i3', 'i4']);
  assert.deepEqual(ids('favorites'), ['i2']);
  assert.deepEqual(ids('attention'), ['i3']);
  assert.deepEqual(ids('weak'), ['i4']);
});

test('a section opens its own channel if one exists, else the All logins tab', () => {
  const channels = normaliseChannels(BUILTIN_CHANNELS);
  assert.deepEqual(sectionTarget(channels, 'favorites'), { channelId: 'all', tab: 'favorites' });
  assert.deepEqual(sectionTarget(channels, 'weak'), { channelId: 'all', tab: 'weak' });
  // No tab for the main view: it *is* the main view.
  assert.deepEqual(sectionTarget(channels, 'all'), { channelId: 'all', tab: 'all' });

  const mine = createChannel('Starred', { kind: 'favorites' });
  assert.deepEqual(sectionTarget([...channels, mine], 'favorites'), { channelId: mine.id });
});

test('tag narrowing still applies inside a tab', () => {
  // A tab swaps the base filter, not the tag filter: "favorites tagged work" has
  // to keep meaning that.
  const channels = normaliseChannels(BUILTIN_CHANNELS);
  const all = channels.find((channel) => channel.kind === 'all')!;
  const items = [
    { ...emptyItem('i1', 1), favorite: true, tags: ['tg_work'] },
    { ...emptyItem('i2', 1), favorite: true, tags: [] },
  ];
  const listed = applyChannel(
    { ...all, kind: 'favorites', tagIds: ['tg_work'] },
    items,
    180,
  );
  assert.deepEqual(listed.map((item) => item.id), ['i1']);
});
