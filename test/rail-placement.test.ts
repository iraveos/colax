import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_CHANNELS,
  composeRailOrder,
  normaliseChannels,
  normaliseSidebar,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../src/vault/channels.ts';

/**
 * Rail placement groups rows into three stable blocks, and the tree it runs on
 * has to survive the round-trip through storage without ever drawing a row
 * twice. These guard the two failure modes that were reported: choosing a
 * placement duplicated rows, and placement inside a folder looked like a no-op.
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

const positionOf = (map: Record<string, 'top' | 'middle' | 'bottom'>) =>
  (entry: SidebarEntry): 'top' | 'middle' | 'bottom' =>
    (entry.kind === 'channel' && map[entry.id]) || 'middle';

test('top, middle and bottom rows are split into stable blocks', () => {
  const tree: SidebarEntry[] = [
    { kind: 'channel', id: 'a' },
    { kind: 'channel', id: 'b' },
    { kind: 'channel', id: 'c' },
    { kind: 'channel', id: 'd' },
  ];
  const ordered = composeRailOrder(
    tree,
    positionOf({ b: 'top', a: 'bottom', d: 'bottom' }),
  );
  // `c` is the only middle row; the two top/bottom blocks keep their own order.
  assert.deepEqual(flat(ordered), ['channel:b', 'channel:c', 'channel:a', 'channel:d']);
});

test('placement is applied inside a folder as well as at the root', () => {
  const tree: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }, { kind: 'channel', id: 'b' }] },
  ];
  const ordered = composeRailOrder(tree, positionOf({ b: 'top' }));
  const folder = ordered[0];
  assert.equal(folder?.kind, 'folder');
  if (folder?.kind === 'folder') {
    assert.deepEqual(flat(folder.children), ['channel:b', 'channel:a']);
  }
});

test('a row with no placement keeps the drag order around it', () => {
  const tree: SidebarEntry[] = [
    { kind: 'channel', id: 'c' },
    { kind: 'channel', id: 'a' },
    { kind: 'channel', id: 'b' },
  ];
  assert.deepEqual(flat(composeRailOrder(tree, positionOf({}))), ['channel:c', 'channel:a', 'channel:b']);
});

test('a stored copy of the synthetic Unassigned row is dropped on load', () => {
  // The rail-placement menu could save the pseudo row; because the tree also
  // kept the synthetic entry, the rail then drew Unassigned twice forever.
  const channels = normaliseChannels([
    ...BUILTIN_CHANNELS,
    { ...BUILTIN_CHANNELS[0]!, id: 'unassigned', name: 'Unassigned', kind: 'unassigned' as const },
  ]);
  assert.ok(!channels.some((channel) => channel.id === 'unassigned'));
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
