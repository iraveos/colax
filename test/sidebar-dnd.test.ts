import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveSidebarEntry,
  moveChannelToFolder,
  normaliseSidebar,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../src/vault/channels.ts';

const CHANNELS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Channel[];
const FOLDERS = [{ id: 'f1' }, { id: 'f2' }] as Folder[];

/** Flattens the tree to "id@list" pairs so a failure names an exact position. */
function shape(entries: SidebarEntry[]): string[] {
  const out: string[] = [];
  const walk = (list: SidebarEntry[], where: string) => {
    for (const entry of list) {
      if (entry.kind === 'folder') {
        out.push(`folder:${entry.id}`);
        walk(entry.children, entry.id);
      } else {
        out.push(`${entry.kind}:${entry.id}@${where}`);
      }
    }
  };
  walk(entries, 'root');
  return out;
}

/** Every non-folder entry, as a sorted id list, to prove nothing is lost. */
function contents(entries: SidebarEntry[]): string[] {
  return shape(entries)
    .filter((s) => !s.startsWith('folder:'))
    .map((s) => s.split('@')[0]!.split(':')[1]!)
    .sort();
}

const ROOT: SidebarEntry[] = [
  { kind: 'folder', id: 'f1', children: [] },
  { kind: 'folder', id: 'f2', children: [] },
  { kind: 'channel', id: 'a' },
  { kind: 'channel', id: 'b' },
  { kind: 'channel', id: 'c' },
];

test('moving into a folder places the entry inside it', () => {
  assert.deepEqual(shape(moveSidebarEntry(ROOT, 'a', 'f1', 0)), [
    'folder:f1',
    'channel:a@f1',
    'folder:f2',
    'channel:b@root',
    'channel:c@root',
  ]);
});

test('moving out of a folder places the entry at the root slot', () => {
  const start: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'channel', id: 'b' },
  ];
  assert.deepEqual(shape(moveSidebarEntry(start, 'a', 'root', 1)), ['folder:f1', 'channel:a@root', 'channel:b@root']);
});

test('moving between two folders works', () => {
  assert.deepEqual(shape(moveSidebarEntry(ROOT, 'a', 'f2', 0)), [
    'folder:f1',
    'folder:f2',
    'channel:a@f2',
    'channel:b@root',
    'channel:c@root',
  ]);
});

test('a move round-trips: into a folder and straight back out', () => {
  const into = moveSidebarEntry(ROOT, 'b', 'f1', 0);
  const back = moveSidebarEntry(into, 'b', 'root', 0);
  assert.deepEqual(shape(back), ['channel:b@root', 'folder:f1', 'folder:f2', 'channel:a@root', 'channel:c@root']);
});

test('reordering within the root lands on the dropped slot', () => {
  // Every source/destination pair, which is where the old index arithmetic
  // used to put rows one slot out.
  const start = ROOT.filter((e) => e.kind !== 'folder');
  for (let from = 0; from < start.length; from += 1) {
    for (let to = 0; to < start.length; to += 1) {
      const out = moveSidebarEntry(start, (start[from] as { id: string }).id, 'root', to);
      const movedId = (start[from] as { id: string }).id;
      if (from === to) continue;
      const at = (out[to] as { id: string }).id;
      assert.equal(at, movedId, `from ${from} to ${to} => ${shape(out).join(',')}`);
    }
  }
});

test('reordering within a folder lands on the dropped slot', () => {
  const start: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }, { kind: 'channel', id: 'b' }, { kind: 'channel', id: 'c' }] },
  ];
  assert.deepEqual(shape(moveSidebarEntry(start, 'a', 'f1', 2)), [
    'folder:f1',
    'channel:b@f1',
    'channel:c@f1',
    'channel:a@f1',
  ]);
});

test('a separator moves like any other entry', () => {
  const start: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [] },
    { kind: 'separator', id: 's1' },
    { kind: 'channel', id: 'a' },
  ];
  const out = moveSidebarEntry(start, 's1', 'f1', 0);
  assert.deepEqual(shape(out), ['folder:f1', 'separator:s1@f1', 'channel:a@root']);
});

test('no move ever loses or duplicates an entry', () => {
  const lists = ['root', 'f1', 'f2'] as const;
  const movable = ['a', 'b', 'c'];
  const before = contents(ROOT);
  for (const id of movable) {
    for (const from of lists) {
      const staged = moveChannelToFolder(ROOT, id, from === 'root' ? null : from);
      for (const to of lists) {
        for (let index = 0; index <= 4; index += 1) {
          const out = moveSidebarEntry(staged, id, to, index);
          assert.deepEqual(contents(out), before, `${id} ${from} -> ${to}@${index}`);
        }
      }
    }
  }
});

test('a folder cannot be dropped inside another folder', () => {
  const out = moveSidebarEntry(ROOT, 'f1', 'f2', 0);
  assert.deepEqual(shape(out), shape(ROOT), 'folders must not nest');
});

test('a folder can still be reordered at the root', () => {
  const out = moveSidebarEntry(ROOT, 'f1', 'root', 3);
  assert.deepEqual(shape(out), ['folder:f2', 'channel:a@root', 'channel:b@root', 'folder:f1', 'channel:c@root']);
});

test('an unknown entry id leaves the tree untouched', () => {
  assert.deepEqual(shape(moveSidebarEntry(ROOT, 'nope', 'f1', 0)), shape(ROOT));
});

test('dropping into a folder that does not exist falls back to the root', () => {
  const out = moveSidebarEntry(ROOT, 'a', 'ghost', 0);
  assert.deepEqual(contents(out), contents(ROOT), 'the entry must survive');
});

test('an out-of-range index is clamped rather than throwing', () => {
  assert.deepEqual(shape(moveSidebarEntry(ROOT, 'a', 'root', 999)), [
    'folder:f1',
    'folder:f2',
    'channel:b@root',
    'channel:c@root',
    'channel:a@root',
  ]);
  assert.deepEqual(shape(moveSidebarEntry(ROOT, 'a', 'root', -5)), [
    'channel:a@root',
    'folder:f1',
    'folder:f2',
    'channel:b@root',
    'channel:c@root',
  ]);
});

test('every move survives a reload through normaliseSidebar', () => {
  for (const id of ['a', 'b', 'c']) {
    for (const list of ['f1', 'f2'] as const) {
      const moved = moveSidebarEntry(ROOT, id, list, 0);
      const reloaded = normaliseSidebar(moved, CHANNELS, FOLDERS);
      const folder = reloaded.find((e) => e.kind === 'folder' && e.id === list);
      assert.ok(folder && folder.kind === 'folder');
      assert.equal(folder.children[0]?.id, id, `${id} in ${list} must persist`);
    }
  }
});

test('moveChannelToFolder appends into the target folder', () => {
  const start: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'channel', id: 'b' },
  ];
  assert.deepEqual(shape(moveChannelToFolder(start, 'b', 'f1')), ['folder:f1', 'channel:a@f1', 'channel:b@f1']);
});

test('moveChannelToFolder with null sends the entry to the root', () => {
  const start: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'channel', id: 'b' },
  ];
  assert.deepEqual(shape(moveChannelToFolder(start, 'a', null)), [
    'folder:f1',
    'channel:b@root',
    'channel:a@root',
  ]);
});

test('moveChannelToFolder into a missing folder keeps the entry', () => {
  const out = moveChannelToFolder(ROOT, 'a', 'ghost');
  assert.deepEqual(contents(out), contents(ROOT));
});