import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_CHANNELS,
  CHANNELS_FOLDER_NAME,
  createChannel,
  createFolder,
  groupChannelsIntoFolder,
  normaliseChannels,
  normaliseSidebar,
  type SidebarEntry,
} from '../src/vault/channels.ts';

/**
 * The one-time tidy that puts the channel list in a folder.
 *
 * The rules worth pinning: Dashboard and Mail never move, the order the rail
 * already had is the order the folder gets, and a rail that is already grouped
 * is left completely alone — that last one is what stops the pass from being
 * re-applied over someone's own arrangement.
 */

function flat(entries: SidebarEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'channel') out.push(entry.id);
    else if (entry.kind === 'folder') {
      out.push(`[${entry.id}`);
      out.push(...flat(entry.children));
      out.push(']');
    } else out.push('|');
  }
  return out;
}

test('every channel except Dashboard and Mail ends up in one folder', () => {
  const channels = normaliseChannels([...BUILTIN_CHANNELS, createChannel('Work')]);
  const sidebar = normaliseSidebar(undefined, channels, []);
  const result = groupChannelsIntoFolder(channels, [], sidebar);
  assert.ok(result, 'there was something to group');

  const folder = result.folders.find((entry) => entry.name === CHANNELS_FOLDER_NAME);
  assert.ok(folder, 'a Channels folder was created');

  // Root: exactly the two structural screens, plus the folder.
  assert.deepEqual(
    flat(result.sidebar),
    ['dashboard', 'mail', `[${folder.id}`, ...[...flat(sidebar).filter((id) => id !== 'dashboard' && id !== 'mail')], ']'],
  );

  // Nothing moved outside the folder, and nothing was lost.
  const inside = flat(result.sidebar.slice(2));
  assert.ok(inside.includes('all'));
  assert.ok(inside.includes('history'), 'History is a channel like any other here');
  assert.ok(!result.sidebar.some((entry) => entry.kind === 'channel' && entry.id === 'weak'));
});

test('a rail that is already grouped is left alone', () => {
  const channels = normaliseChannels(BUILTIN_CHANNELS);
  const folder = createFolder(CHANNELS_FOLDER_NAME, { id: 'f_channels' });
  const children = channels
    .filter((channel) => channel.kind !== 'dashboard' && channel.kind !== 'mail')
    .map((channel) => ({ kind: 'channel', id: channel.id }) as SidebarEntry);
  const sidebar: SidebarEntry[] = [
    { kind: 'channel', id: 'dashboard' },
    { kind: 'channel', id: 'mail' },
    { kind: 'folder', id: folder.id, children },
  ];
  assert.equal(groupChannelsIntoFolder(channels, [folder], sidebar), null);

  // …but a channel dragged back out to the root means it is no longer tidy, and
  // the (already stamped) caller would not run again — this is the guard that
  // makes a manual re-run idempotent, not the thing that undoes the user's drag.
  assert.ok(groupChannelsIntoFolder(channels, [folder], [
    { kind: 'channel', id: 'dashboard' },
    { kind: 'channel', id: 'all' },
    { kind: 'folder', id: folder.id, children: children.filter((child) => child.id !== 'all') },
  ]));
});
