import { attachmentBytes, type VaultAttachment } from '../vault/types.ts';

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/zip': 'zip',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** A safe download name for an attachment, including old records with no name. */
export function attachmentFileName(attachment: VaultAttachment, index = 0): string {
  const given = (attachment.name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').slice(0, 180);
  if (given) return given;
  const mapped = EXTENSIONS[attachment.mime.toLowerCase()];
  if (mapped) return `attachment-${index + 1}.${mapped}`;
  const subtype = attachment.mime.split('/')[1] ?? '';
  const cleaned = subtype.split('+')[0]?.replace(/^vnd\./, '').replace(/[^a-z0-9]/gi, '');
  return `attachment-${index + 1}.${cleaned || 'bin'}`;
}

/** Human-readable attachment size for the notes strip. */
export function attachmentSizeLabel(attachment: VaultAttachment): string {
  const bytes = attachmentBytes(attachment.dataUrl);
  if (bytes >= 1_000_000) {
    const mb = bytes / 1_000_000;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
