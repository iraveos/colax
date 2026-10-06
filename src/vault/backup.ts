import type { BackupFile } from './vault-service.ts';

/**
 * On-disk marker. Kept as `aegis-vault-backup` so backups written by earlier
 * builds still import after the rename to Colax.
 */
export const BACKUP_FORMAT = 'aegis-vault-backup' as const;

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('That file is not a vault backup.');
  const candidate = parsed as Partial<BackupFile>;
  if (candidate.format !== BACKUP_FORMAT) throw new Error('That file is not a Colax vault backup.');
  if (!candidate.header || !Array.isArray(candidate.items)) throw new Error('The backup file is incomplete.');
  return candidate as BackupFile;
}

export function backupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `colax-vault-backup-${stamp}.json`;
}

export async function downloadBackup(backup: BackupFile): Promise<void> {
  const blob = new Blob([serializeBackup(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = backupFilename();
  anchor.click();
  // Revoke on the next tick so the download has picked the blob up first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function pickBackupFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then((text) => resolve({ name: file.name, text }), () => resolve(null));
    };
    // A cancelled picker fires no event in most browsers; resolve on focus return.
    window.addEventListener('focus', () => setTimeout(() => resolve(null), 500), { once: true });
    input.click();
  });
}