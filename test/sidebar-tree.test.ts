import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseSidebar,
  moveChannelToFolder,
  BUILTIN_CHANNELS,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../src/vault/channels.ts';

const ch = (id: string): Channel => ({ id } as Channel);

const CHANNELS: Channel[] = [ch('a'), ch('b'), ch('c')];
const FOLDERS: Folder[] = [{ id: 'f1' } as Folder];

/** Flattens the tree to "id@list" pairs so assertions can name a position. */
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

test('a separator first inside a folder survives normalisation', () => {
  // Pre-fix: the separator guard also required `out.length > 0`, so a
  // separator that was a folder's first child was deleted on every load.
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'separator', id: 's1' }, { kind: 'channel', id: 'a' }] },
  ];
  const out = normaliseSidebar(stored, CHANNELS, FOLDERS);
  const folder = out.find((e) => e.kind === 'folder');
  assert.ok(folder && folder.kind === 'folder');
  assert.equal(folder.children[0]?.kind, 'separator', 'leading separator inside a folder must survive');
});

test('a leading separator at the root survives normalisation', () => {
  const stored: SidebarEntry[] = [{ kind: 'separator', id: 's1' }, { kind: 'channel', id: 'a' }];
  const out = normaliseSidebar(stored, CHANNELS, FOLDERS);
  assert.equal(out[0]?.kind, 'separator');
});

test('consecutive separators are collapsed but a single one is kept', () => {
  const stored: SidebarEntry[] = [
    { kind: 'channel', id: 'a' },
    { kind: 'separator', id: 's1' },
    { kind: 'separator', id: 's2' },
    { kind: 'channel', id: 'b' },
  ];
  const out = normaliseSidebar(stored, CHANNELS, FOLDERS);
  const seps = out.filter((e) => e.kind === 'separator');
  assert.equal(seps.length, 1);
});

test('a channel moves from the root into a folder', () => {
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [] },
    { kind: 'channel', id: 'a' },
    { kind: 'channel', id: 'b' },
  ];
  const moved = moveChannelToFolder(stored, 'a', 'f1');
  assert.deepEqual(shape(moved), ['folder:f1', 'channel:a@f1', 'channel:b@root']);
  const reloaded = normaliseSidebar(moved, CHANNELS, FOLDERS);
  assert.deepEqual(shape(reloaded), ['folder:f1', 'channel:a@f1', 'channel:b@root', 'channel:c@root']);
});

test('a channel moves back out of a folder to the root', () => {
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'channel', id: 'b' },
  ];
  const moved = moveChannelToFolder(stored, 'a', null);
  assert.deepEqual(shape(moved), ['folder:f1', 'channel:b@root', 'channel:a@root']);
});

test('a channel moves between two folders', () => {
  const FOLDERS2 = [{ id: 'f1' } as Folder, { id: 'f2' } as Folder];
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'folder', id: 'f2', children: [] },
  ];
  const moved = moveChannelToFolder(stored, 'a', 'f2');
  assert.deepEqual(shape(moved), ['folder:f1', 'folder:f2', 'channel:a@f2']);
  // And the result must survive a reload rather than reverting or vanishing.
  const reloaded = normaliseSidebar(moved, CHANNELS, FOLDERS2);
  assert.deepEqual(shape(reloaded), ['folder:f1', 'folder:f2', 'channel:a@f2', 'channel:b@root', 'channel:c@root']);
});

test('a separator moves into a folder and stays there after a reload', () => {
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [] },
    { kind: 'separator', id: 's1' },
    { kind: 'channel', id: 'a' },
  ];
  const moved = moveChannelToFolder(stored, 's1', 'f1');
  const reloaded = normaliseSidebar(moved, CHANNELS, FOLDERS);
  const folder = reloaded.find((e) => e.kind === 'folder');
  assert.ok(folder && folder.kind === 'folder');
  assert.equal(folder.children[0]?.kind, 'separator');
  assert.equal(folder.children[0]?.id, 's1');
});

test('moving to a folder that is not in the tree never deletes the entry', () => {
  // Pre-fix this stripped the channel and then failed to find the folder to
  // put it back into, so the channel vanished from the sidebar entirely.
  const stored: SidebarEntry[] = [{ kind: 'channel', id: 'a' }, { kind: 'channel', id: 'b' }];
  const moved = moveChannelToFolder(stored, 'a', 'ghost');
  const ids = moved.filter((e) => e.kind === 'channel').map((e) => e.id);
  assert.deepEqual(ids.sort(), ['a', 'b'], 'the channel must survive, not be destroyed');
});

test('moving preserves every channel exactly once', () => {
  const stored: SidebarEntry[] = [
    { kind: 'folder', id: 'f1', children: [{ kind: 'channel', id: 'a' }] },
    { kind: 'channel', id: 'b' },
    { kind: 'channel', id: 'c' },
  ];
  const moved = moveChannelToFolder(stored, 'b', 'f1');
  const seen = shape(moved).filter((s) => s.startsWith('channel:'));
  assert.deepEqual([...seen].sort(), ['channel:a@f1', 'channel:b@f1', 'channel:c@root']);
});

test('builtin channels are all present in the normalised tree', () => {
  const out = normaliseSidebar([], BUILTIN_CHANNELS, []);
  const ids = out.filter((e) => e.kind === 'channel').map((e) => e.id);
  for (const c of BUILTIN_CHANNELS) assert.ok(ids.includes(c.id), `${c.id} missing`);
});