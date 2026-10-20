/**
 * Paste, drop and upload files into a login's notes — the RichNotes editor and
 * ItemEditor feed this, and everything here stays UI-side: the returned data
 * URLs ride the draft into the encrypted item like any other field.
 *
 * Media is kept verbatim rather than canvas-re-encoded, because a canvas pass
 * flattens animated GIFs — the caps in types.ts bound the size instead. Ordinary
 * photos that run past the cap are the one exception: a phone screenshot or
 * camera cut regularly does, so those go through the same downscale card art
 * uses (see readImageFile). GIFs and videos are refused rather than rewritten,
 * and any other file type is stored byte-for-byte up to the same cap.
 */

import {
  MAX_NOTE_ATTACHMENT_BYTES,
  attachmentBytes,
  isNoteMediaMime,
  type VaultAttachment,
} from '../vault/types.ts';
import { newItemId } from '../vault/vault-service.ts';
import { readImageFile } from './card-art.ts';

/**
 * Files from a paste or drop. The clipboard can carry the same picture as a
 * File, a URL string and text at once — the File form wins, so the editor
 * attaches it instead of letting the markup paste duplicate it. Drops from
 * some apps surface the payload only in `files` (screenshots dragged from some
 * tools carry no per-item types), so take what that finds as well.
 */
export function noteFilesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) {
    for (const file of Array.from(transfer.files ?? [])) files.push(file);
  }
  return files;
}

/** Reads a file as its data URL. Gifs/videos want the bytes untouched. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`"${file.name || 'that file'}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * One pasted, dropped or uploaded file in, one attachment out.
 *
 * GIFs and videos pass through byte-for-byte (the cap is the guard); other
 * images try verbatim first and fall back to the downscale path when they run
 * over it. Any other file — a PDF, a document, an archive, plain text — is
 * stored as-is so it can be downloaded again. Throws readable errors so the
 * editor can surface them as a toast.
 */
export async function readNoteAttachment(file: File): Promise<VaultAttachment> {
  const mime = (file.type.split(';')[0] ?? '').trim().toLowerCase() || 'application/octet-stream';
  const name = file.name || undefined;
  const softCap = MAX_NOTE_ATTACHMENT_BYTES;
  const read = async () => {
    const raw = await readDataUrl(file);
    const comma = raw.indexOf(',');
    const dataUrl = `data:${mime};base64,${raw.slice(comma + 1)}`;
    // The stored cap is decoded bytes, so check the actual base64 payload
    // rather than trusting the file size boundary to round the same way.
    if (attachmentBytes(dataUrl) > MAX_NOTE_ATTACHMENT_BYTES) {
      throw new Error(
        `"${file.name || 'That file'}" is ${kb(file.size)} — the limit is ${kb(MAX_NOTE_ATTACHMENT_BYTES)}.`,
      );
    }
    return dataUrl;
  };

  if (file.size === 0) {
    throw new Error(`"${file.name || 'That file'}" is empty.`);
  }

  if (!isNoteMediaMime(mime)) {
    if (file.size > softCap) {
      throw new Error(
        `"${file.name || 'That file'}" is ${kb(file.size)} — the limit is ${kb(MAX_NOTE_ATTACHMENT_BYTES)}.`,
      );
    }
    return {
      id: newItemId(),
      mime,
      name,
      dataUrl: await read(),
    };
  }

  const isVideo = mime.startsWith('video/');
  const isGif = mime === 'image/gif';

  if (!isVideo && !isGif && file.size > softCap) {
    // Too big to keep verbatim: re-encode. This drops the original format
    // (an animated png/webp loses frames, which is why this branch is never
    // taken for GIFs) but downscaled photos land far under the cap.
    try {
      const compressed = await readImageFile(file, MAX_NOTE_ATTACHMENT_BYTES);
      const compressedMime = compressed.slice(5, compressed.indexOf(';'));
      return {
        id: newItemId(),
        mime: isNoteMediaMime(compressedMime) ? compressedMime : 'image/jpeg',
        dataUrl: compressed,
        name,
      };
    } catch {
      throw new Error(
        `"${file.name || 'That image'}" is ${kb(file.size)} — above the ${kb(MAX_NOTE_ATTACHMENT_BYTES)} limit even after compressing.`,
      );
    }
  }

  if (file.size > softCap) {
    throw new Error(
      `"${file.name || mime}" is ${kb(file.size)} — the limit is ${kb(MAX_NOTE_ATTACHMENT_BYTES)}.`,
    );
  }

  return { id: newItemId(), mime, dataUrl: await read(), name };
}
