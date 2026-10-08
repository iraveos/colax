/**
 * Bulk actions for a multi-selection of logins.
 *
 * The whole point of this module is the field-diff rule, so it lives here rather
 * than in App where it would be a hundred lines of menu construction with one
 * load-bearing rule buried in the middle of it.
 *
 * ## The rule
 *
 * A bulk edit only touches fields the user actually opened and changed.
 *
 * The failure this prevents is specific and easy to ship by accident: you select
 * four logins to give them all a theme, pick one colour, apply, and afterwards
 * all four share one title. It happens because a bulk form is usually built by
 * seeding itself from the first selected item and then writing the whole form
 * back. The first item's title is not a value the user typed, it is a value the
 * form happened to start on, and writing it to the other three destroys data
 * that nothing in the interaction suggested was going to change.
 *
 * So every field is either `undefined` (leave whatever that login already has)
 * or a concrete value, and `diffBulkEdit` drops the undefined ones before the
 * patch is built. A login whose title already equals the new title is not
 * written at all, which keeps `updatedAt` honest.
 */

import type { ReactNode } from 'react';
// A type-only import, but resolved through the .tsx extension, which the test
// tsconfig compiles without JSX enabled. The menu shape is declared here rather
// than imported so this module stays plain TypeScript and testable on its own.
import type { VaultItem } from '../vault/types.ts';

/** Mirrors the MenuItem union in context-menu.tsx. */
export type MenuItem =
  | {
      kind: 'item';
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      onSelect?: () => void;
    }
  | { kind: 'separator' }
  | {
      kind: 'submenu';
      label: string;
      icon?: ReactNode;
      items: MenuItem[];
      disabled?: boolean;
      heading?: string;
    };
import { EMPTY_SECURITY } from '../crypto/security.ts';
import type { LoginSecurity } from '../crypto/security.ts';

/** A title the user has not edited. Never written to any login. */
export const UNTOUCHED = undefined;

/**
 * What a bulk edit wants to change. A field left as `undefined` is not applied.
 *
 * `title` is here even though applying a title to several logins is usually a
 * mistake: the guard is that the user must type into the field, and this type
 * makes "did they type" the only thing that can produce a value.
 */
export interface BulkEdit {
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  favorite?: boolean;
  needsAttention?: boolean;
  tags?: string[];
  accentHue?: number | null;
  backgroundImage?: string;
  /** Replaces each login's whole security block. Only set by the security panel. */
  security?: LoginSecurity;
}

/**
 * Builds the per-login patch, containing only the fields that changed.
 *
 * Returns undefined for a login that needs no change at all, so the caller can
 * skip the write entirely.
 */
export function diffBulkEdit(item: VaultItem, edit: BulkEdit): Partial<VaultItem> | undefined {
  const patch: Partial<VaultItem> = {};
  let dirty = false;

  // A field is applied when the caller supplied one AND it differs from what the
  // login already holds. Comparing first is what stops a no-op edit from
  // touching updatedAt on every selected login.
  if (edit.title !== UNTOUCHED && edit.title !== item.title) {
    patch.title = edit.title;
    dirty = true;
  }
  if (edit.username !== UNTOUCHED && edit.username !== item.username) {
    patch.username = edit.username;
    dirty = true;
  }
  if (edit.url !== UNTOUCHED && edit.url !== item.url) {
    patch.url = edit.url;
    dirty = true;
  }
  if (edit.notes !== UNTOUCHED && edit.notes !== item.notes) {
    patch.notes = edit.notes;
    dirty = true;
  }
  // A password change is special: it also moves passwordUpdatedAt, otherwise the
  // "this password is old" health check would still call a just-rotated
  // password stale.
  if (edit.password !== UNTOUCHED && edit.password !== item.password) {
    patch.password = edit.password;
    patch.passwordUpdatedAt = Date.now();
    dirty = true;
  }
  if (edit.favorite !== UNTOUCHED && edit.favorite !== item.favorite) {
    patch.favorite = edit.favorite;
    dirty = true;
  }
  if (edit.needsAttention !== UNTOUCHED && edit.needsAttention !== item.needsAttention) {
    patch.needsAttention = edit.needsAttention;
    dirty = true;
  }
  if (edit.tags !== UNTOUCHED && !sameTags(edit.tags, item.tags)) {
    patch.tags = [...edit.tags];
    dirty = true;
  }
  if (edit.accentHue !== UNTOUCHED && edit.accentHue !== item.accentHue) {
    patch.accentHue = edit.accentHue;
    dirty = true;
  }
  if (edit.backgroundImage !== UNTOUCHED && edit.backgroundImage !== item.backgroundImage) {
    patch.backgroundImage = edit.backgroundImage;
    dirty = true;
  }
  if (edit.security !== UNTOUCHED && !sameSecurity(edit.security, item.security)) {
    patch.security = edit.security;
    dirty = true;
  }

  return dirty ? patch : undefined;
}

/** Tag order is not meaningful, so this compares as a set. */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

function sameSecurity(a: LoginSecurity, b: LoginSecurity): boolean {
  const seedA = a.totp?.seed ?? null;
  const seedB = b.totp?.seed ?? null;
  if (seedA !== seedB) return false;
  if ((a.passcode ?? null) !== (b.passcode ?? null)) return false;
  return a.questions.length === b.questions.length;
}

/** How many of the selection the given edit would actually change. */
export function countAffected(items: readonly VaultItem[], edit: BulkEdit): number {
  let count = 0;
  for (const item of items) if (diffBulkEdit(item, edit)) count += 1;
  return count;
}

/**
 * The bulk edit starts empty, not seeded from the first login.
 *
 * This is the counterpart to the rule above. Seeding from an existing login is
 * how "change the theme" silently overwrites four titles: the form looks filled
 * in, so the untouched fields read as intentional. An empty form with a
 * placeholder is unambiguous — nothing is pending until the user types.
 */
export function emptyBulkEdit(): BulkEdit {
  return {};
}

/** Applies the diff across a selection. Returns how many logins changed. */
export function applyBulkEdit(
  items: readonly VaultItem[],
  edit: BulkEdit,
  write: (id: string, patch: Partial<VaultItem>) => Promise<void>,
): Promise<number> {
  let changed = 0;
  return (async () => {
    for (const item of items) {
      const patch = diffBulkEdit(item, edit);
      if (!patch) continue;
      await write(item.id, patch);
      changed += 1;
    }
    return changed;
  })();
}

/**
 * The login whose security block is common to the whole selection.
 *
 * Returns null when they disagree, which is what makes the bulk security panel
 * show "mixed" instead of silently adopting the first login's factors. Copying
 * one login's TOTP seed onto every other selected login would lock the user out
 * of all of them at once, so a disagreement has to be resolved by hand.
 */
export function commonSecurity(items: readonly VaultItem[]): LoginSecurity | null {
  if (items.length === 0) return null;
  const first = items[0]!;
  const seed = first.security.totp?.seed ?? null;
  const passcode = first.security.passcode ?? null;
  const questions = first.security.questions.length;
  for (const item of items.slice(1)) {
    if ((item.security.totp?.seed ?? null) !== seed) return null;
    if ((item.security.passcode ?? null) !== passcode) return null;
    if (item.security.questions.length !== questions) return null;
  }
  return seed === null && passcode === null && questions === 0 ? EMPTY_SECURITY : first.security;
}

/**
 * Builds the context menu for a selection.
 *
 * Labels are pluralised off the count so the menu states its own scope: "3
 * logins selected" in the header, and every action phrased against that number.
 * An action that does not say how many things it will affect is the sort of thing
 * that gets clicked by reflex and then undone.
 */
export function bulkMenu(options: {
  items: readonly VaultItem[];
  onShare: () => void;
  onEditFields: () => void;
  onEditSecurity: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  icon: {
    share: ReactNode;
    edit: ReactNode;
    shield: ReactNode;
    trash: ReactNode;
    all: ReactNode;
  };
}): MenuItem[] {
  const count = options.items.length;
  const plural = count === 1 ? 'login' : 'logins';
  const noun = `${count} ${plural}`;
  const named = count === 1 ? `“${options.items[0]?.title || 'Untitled'}”` : noun;

  return [
    { kind: 'submenu', label: 'Select', items: [
      { kind: 'item', label: `Select all in view (${count} ${plural})`, icon: options.icon.all, onSelect: options.onSelectAll },
      { kind: 'item', label: 'Clear selection', onSelect: options.onClear },
    ] },
    { kind: 'separator' },
    {
      kind: 'item',
      // Short on purpose. Sharing a credential should be one click and no
      // confirmation theatre; it copies to the clipboard like any other copy.
      label: `Share ${named}`,
      icon: options.icon.share,
      onSelect: options.onShare,
    },
    {
      kind: 'submenu',
      label: `Edit ${noun}`,
      icon: options.icon.edit,
      items: [
        { kind: 'item', label: 'Title', onSelect: options.onEditFields },
        { kind: 'item', label: 'Notes', onSelect: options.onEditFields },
        { kind: 'item', label: 'Tags', onSelect: options.onEditFields },
        { kind: 'item', label: 'Theme', onSelect: options.onEditFields },
        { kind: 'separator' },
        { kind: 'item', label: 'Security', icon: options.icon.shield, onSelect: options.onEditSecurity },
      ],
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: count === 1 ? 'Delete login' : `Delete ${noun}`,
      icon: options.icon.trash,
      danger: true,
      onSelect: options.onDelete,
    },
  ];
}
