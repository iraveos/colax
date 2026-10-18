/**
 * Theme and layout backup.
 *
 * The encrypted vault backup is the right file for credentials, but it is all
 * or nothing: restoring one puts every login back too. This file is the other
 * half — the look of the app plus the furniture around it: appearance settings,
 * background, card sizing, channels, folders, tags, the sidebar tree, docks and
 * saved Optimize profiles.
 *
 * There are deliberately no logins here and nothing secret beyond the fact that
 * a folder is called "Work". That is what makes it safe to copy between
 * machines, hand to a friend, or keep beside a screenshot of a layout you liked.
 *
 * Plain JSON, tolerant on read: it is normal for a theme saved by an older
 * build to be missing the fields a newer one has, and `normalisePreferences`
 * fills those in on import. What this module does guarantee is that the file is
 * recognisably *this* file — not an encrypted vault backup, and not some other
 * JSON document that would half-apply if it were allowed through.
 */

import type { VaultPreferences } from './storage.ts';

/** On-disk marker. Distinct from `aegis-vault-backup` on purpose. */
export const THEME_BACKUP_FORMAT = 'colax-theme-backup' as const;

/**
 * Everything a theme owns. Deliberately a whitelist: a preferences object also
 * carries mail accounts, alarms, usage counts and the history log, and copying
 * those between installs would either leak data or break the receiving vault.
 */
const THEME_KEYS = [
  // Appearance
  'theme',
  'accent',
  'motion',
  'motionSpeed',
  'microMotion',
  'ambient',
  'density',
  'roundness',
  'cardDepth',
  'cardSize',
  'textScale',
  'reduceTransparency',
  'highContrast',
  'disableSpellcheck',
  'floatingChrome',
  'hideDividers',
  'showTagChips',
  'listTabs',
  'notifications',
  // Background
  'backgroundImage',
  'backgroundOpacity',
  'backgroundBlur',
  'backgroundDim',
  // Layout and views
  'view',
  'sort',
  'showUrls',
  'pinFavorites',
  'compactSidebar',
  'showSidebar',
  'sidebarLabels',
  'viewLabels',
  'viewLabelsByView',
  'sidebarPosition',
  'showLetterGroups',
  'showShortcuts',
  // Channels, folders, tags and their tree
  'channels',
  'tags',
  'folders',
  'sidebar',
  'tagSort',
  'autoTagChannel',
  'showUnassignedChannel',
  'hiddenChannels',
  'hiddenFolders',
  'hiddenButtons',
  'manualOrder',
  'manualOrderByScope',
  // Buttons that are part of the arrangement
  'showNewChannelButton',
  'showCompactButton',
  'showNewLoginButton',
  'showBulkAddButton',
  'showSettingsButton',
  'showHideSidebarButton',
  // Bars and saved looks
  'docks',
  'optimizeProfiles',
  'optimizeSnapshot',
  'activeOptimizeProfile',
] as const satisfies readonly (keyof VaultPreferences)[];

export type ThemeKey = (typeof THEME_KEYS)[number];

export interface ThemeBackup {
  format: typeof THEME_BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  /** Optional human label, used only in the toast after an import. */
  label?: string;
  preferences: Partial<Pick<VaultPreferences, ThemeKey>>;
}

/**
 * Picks the theme-owned fields out of a live preferences object.
 *
 * A whitelist rather than a denylist: a preference added in future defaults to
 * *not* travelling until someone decides it should, which is the safe direction
 * for a file meant to be shared.
 */
export function themeBackupFrom(prefs: VaultPreferences, label?: string): ThemeBackup {
  const preferences: Partial<Pick<VaultPreferences, ThemeKey>> = {};
  for (const key of THEME_KEYS) {
    // Structured clone via JSON is enough: everything here is plain data.
    (preferences as Record<string, unknown>)[key] = JSON.parse(JSON.stringify(prefs[key] ?? null));
  }
  return {
    format: THEME_BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
    preferences,
  };
}

export function serializeThemeBackup(backup: ThemeBackup): string {
  return JSON.stringify(backup, null, 2);
}

export function parseThemeBackup(text: string): ThemeBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('That file is not a theme backup.');
  const candidate = parsed as Partial<ThemeBackup>;
  if (candidate.format !== THEME_BACKUP_FORMAT) {
    throw new Error('That file is not a Colax theme backup. (Vault backups are restored from Restore from backup.)');
  }
  const prefs = candidate.preferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw new Error('The theme backup has no settings in it.');
  }
  return {
    format: THEME_BACKUP_FORMAT,
    version: 1,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    ...(typeof candidate.label === 'string' && candidate.label ? { label: candidate.label } : {}),
    preferences: prefs as ThemeBackup['preferences'],
  };
}

/**
 * The preferences patch an import applies.
 *
 * Only keys the file actually carries come back, so a theme saved before a
 * setting existed does not reset that setting to a default on the receiving
 * vault. Values are not validated here — `normalisePreferences` is the single
 * place that knows every field's legal range, and it runs on the write.
 */
export function themeBackupPreferences(backup: ThemeBackup): Partial<VaultPreferences> {
  const next: Partial<VaultPreferences> = {};
  for (const key of THEME_KEYS) {
    if (!(key in backup.preferences)) continue;
    (next as Record<string, unknown>)[key] = backup.preferences[key];
  }
  return next;
}

export function themeBackupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `colax-theme-${stamp}.json`;
}

export function downloadThemeBackup(backup: ThemeBackup): void {
  const blob = new Blob([serializeThemeBackup(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = themeBackupFilename();
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
