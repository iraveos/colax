import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_CHANNELS,
  normaliseChannels,
  normaliseSidebar,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../src/vault/channels.ts';
import { DEFAULT_PREFERENCES, normalisePreferences } from '../src/vault/storage.ts';

/**
 * Rail alignment is one setting for the whole run of channels, and the tree it
 * applies to has to survive a round-trip through storage without ever drawing a
 * row twice. These guard the storage side of that, plus the two corruption
 * cases that were reported while per-row placement existed.
 */

const CHANNELS: Channel[] = [
  { id: 'a' } as Channel,
  { id: 'b' } as Channel,
  { id: 'c' } as Channel,
  { id: 'd' } as Channel,
];
const FOLDERS: Folder[] = [{ id: 'f1' } as Folder];

const flat = (entries: SidebarEntry[]): string[] =>
  entries.map((entry) => (entry.kind === 'folder' ? `folder:${entry.id}` : `${entry.kind}:${entry.id}`));

const stored = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...(structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>),
  ...patch,
});

test('rail alignment defaults to top', () => {
  assert.equal(normalisePreferences(stored({})).railAlign, 'top');
  assert.equal(DEFAULT_PREFERENCES.railAlign, 'top');
});

test('rail alignment accepts the three known values', () => {
  for (const value of ['top', 'middle', 'bottom'] as const) {
    assert.equal(normalisePreferences(stored({ railAlign: value })).railAlign, value);
  }
});

test('an unknown rail alignment falls back to top', () => {
  assert.equal(normalisePreferences(stored({ railAlign: 'sideways' })).railAlign, 'top');
  assert.equal(normalisePreferences(stored({ railAlign: 42 })).railAlign, 'top');
});

test('a stored copy of the synthetic Unassigned row is dropped on load', () => {
  // The old per-row placement menu could save the pseudo row; because the tree
  // also kept the synthetic entry, the rail then drew Unassigned twice forever.
  const channels = normaliseChannels([
    ...BUILTIN_CHANNELS,
    { ...BUILTIN_CHANNELS[0]!, id: 'unassigned', name: 'Unassigned', kind: 'unassigned' as const },
  ]);
  assert.ok(!channels.some((channel) => channel.id === 'unassigned'));
});

test('the retired per-row railPosition field is not carried forward', () => {
  const channels = normaliseChannels([
    ...BUILTIN_CHANNELS,
    { ...BUILTIN_CHANNELS[0]!, id: 'a', name: 'A', kind: 'all', railPosition: 'top' } as unknown as Channel,
  ]);
  const a = channels.find((channel) => channel.id === 'a');
  assert.ok(a);
  assert.equal('railPosition' in a, false);
});

test('a tree that repeats a channel or a separator draws each row once', () => {
  // This is what a corrupted save cycle left behind; normalisation is the last
  // line of defence so the rail can never render the same key twice.
  const tree: SidebarEntry[] = [
    { kind: 'channel', id: 'a' },
    { kind: 'separator', id: 's1' },
    { kind: 'separator', id: 's1' },
    { kind: 'channel', id: 'a' },
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }, { kind: 'channel', id: 'b' }] },
  ];
  const clean = normaliseSidebar(tree, CHANNELS, FOLDERS);
  assert.deepEqual(flat(clean), ['channel:a', 'separator:s1', 'folder:f1', 'channel:c', 'channel:d']);
  const folder = clean.find((entry) => entry.kind === 'folder');
  assert.equal(folder?.kind, 'folder');
  // `a` already sits at the root, so the folder keeps only `b`.
  if (folder?.kind === 'folder') assert.deepEqual(flat(folder.children), ['channel:b']);
});
