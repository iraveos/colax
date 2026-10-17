import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseThemeBackup,
  serializeThemeBackup,
  themeBackupFrom,
  themeBackupPreferences,
} from '../src/vault/theme-backup.ts';
import { createChannel, createFolder } from '../src/vault/channels.ts';
import { DEFAULT_PREFERENCES, normalisePreferences, type VaultPreferences } from '../src/vault/storage.ts';

/**
 * The theme backup is the shareable half of a vault: the look, the channels,
 * the folders, their tags and notes. It must never carry a credential, a
 * mailbox, an alarm or the history log — those belong to the encrypted vault
 * backup, and copying them between installs would either leak data or break
 * the receiving vault.
 */

function prefs(over: Partial<VaultPreferences> = {}): VaultPreferences {
  return { ...DEFAULT_PREFERENCES, ...over };
}

test('a theme round-trips through serialisation', () => {
  const folder = createFolder('Work', {
    id: 'fd_1',
    tagIds: ['tg_work'],
    altTagIds: ['tg_alt'],
    notes: 'Keys are in the drawer',
  });
  const channel = createChannel('Work logins', { tagIds: ['tg_work'] });
  const source = prefs({
    accent: 'dusk',
    backgroundImage: 'https://example.com/bg.jpg',
    folders: [folder],
    channels: [channel],
    tags: [{ id: 'tg_work', name: 'work', hue: 12 }],
    sidebar: [{ kind: 'folder', id: 'fd_1', children: [{ kind: 'channel', id: channel.id }] }],
  });

  const restored = themeBackupPreferences(parseThemeBackup(serializeThemeBackup(themeBackupFrom(source, 'Mine'))));

  assert.equal(restored.accent, 'dusk');
  assert.equal(restored.backgroundImage, 'https://example.com/bg.jpg');
  assert.deepEqual(restored.tags, [{ id: 'tg_work', name: 'work', hue: 12 }]);
  assert.deepEqual(restored.folders?.[0]?.tagIds, ['tg_work']);
  assert.deepEqual(restored.folders?.[0]?.altTagIds, ['tg_alt']);
  assert.equal(restored.folders?.[0]?.notes, 'Keys are in the drawer');
  assert.equal(restored.sidebar?.[0]?.kind, 'folder');
});

test('credentials, mail, alarms, usage and history never travel in a theme', () => {
  const source = prefs({
    gmailAccounts: [{ id: 'gm_1', address: 'me@x.com', appPassword: 'secret', enabled: true, refreshSeconds: 60 }],
    mailCache: { gm_1: [{ id: 'm1', title: 'Hi', author: 'A', email: 'a@x', summary: '', issued: '', alternate: '', accountId: 'gm_1' }] },
    alarms: [{ id: 'al_1', label: 'Wake', time: '07:00', days: [], sound: null, enabled: true }],
    usage: { i1: { count: 3, at: 1 } },
    history: [{ id: 'he_1', at: 1, action: 'added', itemId: 'i1', title: 'X', username: 'x', before: null }],
  });
  const patch = themeBackupPreferences(themeBackupFrom(source));
  for (const key of ['gmailAccounts', 'mailCache', 'alarms', 'usage', 'history']) {
    assert.equal(key in patch, false, `${key} must not be in a theme backup`);
  }
  // Nothing containing a password can be smuggled in by a hand-edited file.
  const text = serializeThemeBackup(themeBackupFrom(source));
  assert.equal(text.includes('secret'), false);
});

test('importing a theme merges into a live preferences object', () => {
  const source = prefs({ accent: 'sage', folders: [createFolder('Home', { id: 'fd_home', notes: 'wifi' })] });
  const target = normalisePreferences({
    ...DEFAULT_PREFERENCES,
    // A setting the theme file deliberately does not carry.
    confirmDeletes: false,
    ...themeBackupPreferences(themeBackupFrom(source)),
  });
  assert.equal(target.accent, 'sage');
  assert.equal(target.confirmDeletes, false, 'settings the theme does not own are left alone');
  assert.equal(target.folders[0]?.notes, 'wifi');
});

test('a foreign or broken file is refused rather than half-applied', () => {
  assert.throws(() => parseThemeBackup('not json'), /not valid JSON/);
  assert.throws(() => parseThemeBackup('{"format":"aegis-vault-backup"}'), /not a Colax theme backup/);
  assert.throws(() => parseThemeBackup('{"format":"colax-theme-backup"}'), /no settings/);
});
