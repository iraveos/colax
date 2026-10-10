/**
 * The vault's public API: create, unlock, lock, and CRUD over credentials.
 *
 * Deliberately framework-free and promise-based so the UI layer stays thin and
 * this file can move into a native app unchanged.
 */

import {
  createDeviceHeader,
  createPasswordHeader,
  destroyVaultKey,
  generateVaultKey,
  openItems,
  openVaultKey,
  rewrapVaultKey,
  resolveHeader,
  sealItems,
  VaultAuthError,
  type VaultHeader,
  type VaultKeyHandle,
  type VaultProtection,
} from '../crypto/vault-crypto.ts';
import {
  DEFAULT_PREFERENCES,
  type VaultPreferences,
  type VaultStorage,
} from './storage.ts';
import { emptyItem, normalizeUrl, normaliseItem, type StoredItem, type VaultItem } from './types.ts';

export class VaultLockedError extends Error {
  override readonly name = 'VaultLockedError';
  constructor() {
    super('The vault is locked.');
  }
}

export function newItemId(): string {
  return crypto.randomUUID();
}

export class VaultService {
  #handle: VaultKeyHandle | null = null;
  #items: VaultItem[] = [];
  readonly #storage: VaultStorage;

  constructor(storage: VaultStorage) {
    this.#storage = storage;
  }

  get isUnlocked(): boolean {
    return this.#handle !== null;
  }

  /** Plaintext items, or `null` while locked. Callers must not retain the array. */
  get items(): VaultItem[] | null {
    return this.#handle ? this.#items : null;
  }

async exists(): Promise<boolean> {
    return (await this.#storage.loadHeader()) !== null;
  }

  /**
   * How this vault is protected, or null if there is no vault yet.
   * Legacy headers with no `protection` field resolve to 'password'.
   */
  async protection(): Promise<VaultProtection | null> {
    const header = await this.#storage.loadHeader();
    if (!header) return null;
    return resolveHeader(header).protection;
  }

  async preferences(): Promise<VaultPreferences> {
    return this.#storage.loadPreferences();
  }

  async savePreferences(prefs: VaultPreferences): Promise<void> {
    await this.#storage.savePreferences({ ...DEFAULT_PREFERENCES, ...prefs });
  }

  /**
   * Creates a new vault. Passing no password makes it passwordless, which is
   * the default the app now offers; the password can be added later in settings.
   */
  async create(masterPassword?: string): Promise<void> {
    if (await this.exists()) throw new Error('A vault already exists on this device.');
    const handle = await generateVaultKey();
    const header = masterPassword
      ? await createPasswordHeader(masterPassword, handle)
      : createDeviceHeader(handle);
    await this.#storage.saveHeader(header);
    this.#handle = handle;
    this.#items = [];
  }

  /**
   * Opens the vault.
   *
   * For a passwordless vault any input is ignored and this always succeeds.
   * Returns false only when a password was supplied and rejected, so the UI can
   * stay quiet about the reason.
   */
  async unlock(masterPassword?: string): Promise<boolean> {
    const header = await this.#storage.loadHeader();
    if (!header) throw new Error('No vault found on this device.');
    try {
      this.#handle = await openVaultKey(header, masterPassword ?? '');
    } catch (error) {
      if (error instanceof VaultAuthError) return false;
      throw error;
    }
    await this.#load();
    return true;
  }

  lock(): void {
    destroyVaultKey(this.#handle);
    this.#handle = null;
    this.#items = [];
  }

  async #load(): Promise<void> {
    this.#items = await this.#decryptAll(await this.#storage.loadItems());
  }

  async #decryptAll(stored: StoredItem[]): Promise<VaultItem[]> {
    const handle = this.#requireHandle();
const items = await Promise.all(
      stored.map(async (record) => {
        try {
          // Older records predate several fields, so normalise on the way in.
          return normaliseItem(await openItems<VaultItem>(handle, record.id, record.blob));
        } catch {
          // A record that will not decrypt is corrupt or was tampered with.
          // Skip it rather than refusing to open the whole vault.
          return null;
        }
      }),
    );
    return items.filter((item): item is VaultItem => item !== null);
  }

  #requireHandle(): VaultKeyHandle {
    if (!this.#handle) throw new VaultLockedError();
    return this.#handle;
  }

async #persist(item: VaultItem): Promise<VaultItem> {
    const handle = this.#requireHandle();
    const updated = { ...item, url: normalizeUrl(item.url) };
    const blob = await sealItems(handle, updated.id, updated);
    await this.#storage.putItem({ id: updated.id, blob, updatedAt: updated.updatedAt });
    const index = this.#items.findIndex((existing) => existing.id === updated.id);
    if (index === -1) this.#items = [...this.#items, updated];
    else this.#items = this.#items.with(index, updated);
    return updated;
  }

  async addItem(draft: Partial<VaultItem> = {}): Promise<VaultItem> {
    const now = Date.now();
    return this.#persist({ ...emptyItem(newItemId(), now), ...draft });
  }

  async updateItem(id: string, patch: Partial<VaultItem>): Promise<void> {
    const current = this.#items.find((item) => item.id === id);
    if (!current) throw new Error('That item no longer exists.');
const next: VaultItem = { ...current, ...patch, id, updatedAt: Date.now() };

    // Only stamp a change time when that field actually changed, and never move
    // it backwards: a manual date typed in the editor should stick.
    if (patch.password !== undefined && patch.password !== current.password) {
      next.passwordUpdatedAt = patch.passwordUpdatedAt ?? next.updatedAt;
    } else if (patch.passwordUpdatedAt === undefined) {
      next.passwordUpdatedAt = current.passwordUpdatedAt;
    }

    if (patch.username !== undefined && patch.username !== current.username) {
      next.usernameUpdatedAt = patch.usernameUpdatedAt ?? next.updatedAt;
    } else if (patch.usernameUpdatedAt === undefined) {
      next.usernameUpdatedAt = current.usernameUpdatedAt;
    }

    await this.#persist(next);
  }

  /**
   * Flips the attention flag without touching updatedAt.
   *
   * updateItem always stamps updatedAt, which would defeat the purpose here:
   * the untouched-login scan flags by age, so stamping would reset the very
   * clock it read. Flags carry no age semantics of their own, so they bypass it.
   */
  async setAttention(id: string, value: boolean): Promise<void> {
    const current = this.#items.find((item) => item.id === id);
    if (!current) throw new Error('That item no longer exists.');
    if (current.needsAttention === value) return;
    await this.#persist({ ...current, needsAttention: value });
  }

  /**
   * Flips the Messages expander without touching any timestamp.
   *
   * Like setAttention: updateItem always stamps updatedAt, which would reset
   * the "recently updated" order and the untouched-login clock for logins
   * the user never edited. Visibility carries no age semantics of its own,
   * so it bypasses the stamp.
   */
  async setShowMail(id: string, value: boolean): Promise<void> {
    const current = this.#items.find((item) => item.id === id);
    if (!current) throw new Error('That item no longer exists.');
    if (current.showMail === value) return;
    await this.#persist({ ...current, showMail: value });
  }

  async deleteItem(id: string): Promise<void> {
    this.#requireHandle();
    await this.#storage.deleteItem(id);
    this.#items = this.#items.filter((item) => item.id !== id);
  }

  /**
   * Replaces the whole item set in one go, for undo and redo.
   *
   * Items are sealed and stored individually, so restoring means writing every
   * record back. Ids missing from `items` are deleted, which is what makes an undo
   * of "add" actually remove the login again.
   */
  async replaceItems(items: VaultItem[]): Promise<void> {
    const handle = this.#requireHandle();
    const keep = new Set(items.map((item) => item.id));
    for (const existing of this.#items) {
      if (!keep.has(existing.id)) await this.#storage.deleteItem(existing.id);
    }
    for (const item of items) {
      const normalized = { ...item, url: normalizeUrl(item.url) };
      const blob = await sealItems(handle, normalized.id, normalized);
      await this.#storage.putItem({ id: normalized.id, blob, updatedAt: normalized.updatedAt });
    }
    this.#items = items.map((item) => ({ ...item, url: normalizeUrl(item.url) }));
  }

/** Re-wraps the vault key under a new password. Only valid on a password vault. */
  async changeMasterPassword(currentPassword: string, nextPassword: string): Promise<void> {
    const handle = this.#requireHandle();
    const header = await this.#storage.loadHeader();
    if (!header) throw new Error('No vault found on this device.');
    if (resolveHeader(header).protection !== 'password') {
      throw new Error('This vault has no password. Enable one first.');
    }
    // Re-check the current password before writing anything.
    destroyVaultKey(await openVaultKey(header, currentPassword));
    await this.#storage.saveHeader(await rewrapVaultKey(handle, nextPassword));
  }

  /**
   * Turns a passwordless vault into a password-protected one.
   *
   * Only the 32-byte vault key is wrapped, so existing logins stay encrypted
   * under the same key and nothing is re-encrypted.
   */
  async enablePassword(newPassword: string): Promise<void> {
    const handle = this.#requireHandle();
    await this.#storage.saveHeader(await createPasswordHeader(newPassword, handle));
  }

  /**
   * Removes the password requirement from a password-protected vault.
   * The vault key is then stored directly, which means the database alone is
   * enough to read the logins.
   */
  async disablePassword(currentPassword: string): Promise<void> {
    const handle = this.#requireHandle();
    const header = await this.#storage.loadHeader();
    if (!header) throw new Error('No vault found on this device.');
    if (resolveHeader(header).protection !== 'password') {
      throw new Error('This vault already has no password.');
    }
    // Prove the current password before dropping the protection.
    destroyVaultKey(await openVaultKey(header, currentPassword));
    await this.#storage.saveHeader(createDeviceHeader(handle));
  }

  async reset(): Promise<void> {
    this.lock();
    await this.#storage.clear();
  }

  /** Ciphertext-only snapshot for backup. Safe to write to disk as-is. */
  async exportBackup(): Promise<BackupFile> {
    const header = await this.#storage.loadHeader();
    if (!header) throw new Error('No vault found on this device.');
    return {
      format: 'aegis-vault-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      header,
      items: await this.#storage.loadItems(),
    };
  }

  /**
   * Installs a backup on this device, replacing any existing vault.
   *
   * `newPassword` re-keys the vault. Passing an empty string keeps it
   * passwordless; omitting it preserves whatever protection the backup had.
   */
  async restoreBackup(backup: BackupFile, backupPassword?: string, newPassword?: string): Promise<void> {
    if (backup.format !== 'aegis-vault-backup') throw new Error('That is not an Aegis backup file.');
    // Opening the backup is the password check: it either yields the vault key or fails.
    const handle = await openVaultKey(backup.header, backupPassword ?? '');

    let header: VaultHeader;
    if (newPassword === undefined) {
      // Keep the backup's own protection, just pointing at the same vault key.
      header =
        resolveHeader(backup.header).protection === 'password'
          ? await rewrapVaultKey(handle, backupPassword ?? '')
          : createDeviceHeader(handle);
    } else {
      header = newPassword ? await rewrapVaultKey(handle, newPassword) : createDeviceHeader(handle);
    }

    await this.#storage.clear();
    await this.#storage.saveHeader(header);
    // The vault key is unchanged, so existing item ciphertexts stay valid as-is.
    await this.#storage.putItems(backup.items);
    this.#handle = handle;
    this.#items = await this.#decryptAll(backup.items);
  }
}

export interface BackupFile {
  format: 'aegis-vault-backup';
  version: number;
  exportedAt: string;
  header: VaultHeader;
  items: StoredItem[];
}

/**
 * Checks a backup can be opened, without writing anything.
 * Passwordless backups always verify.
 */
export async function verifyBackupPassword(backup: BackupFile, password?: string): Promise<boolean> {
  try {
    destroyVaultKey(await openVaultKey(backup.header, password ?? ''));
    return true;
  } catch {
    return false;
  }
}