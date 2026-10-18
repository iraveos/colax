/**
 * Paste and drop media into a login's notes — the ItemEditor notes-panel
 * handlers feed this, and everything here stays UI-side: the returned data
 * URLs ride the draft into the encrypted item like any other field.
 *
 * Pasted media is kept verbatim rather than canvas-re-encoded, because a
 * canvas pass flattens animated GIFs — the caps in types.ts bound the size
 * instead. Ordinary photos pasted as files are the one exception: a phone
 * screenshot or camera cut regularly runs past the per-attachment cap, so
 * those go through the same downscale card art uses (see readImageFile), and
 * only GIFs and videos are refused rather than rewritten.
 */

import {
  MAX_NOTE_ATTACHMENT_BYTES,
  isNoteMediaMime,
  type VaultAttachment,
} from '../vault/types.ts';
import { newItemId } from '../vault/vault-service.ts';
import { readImageFile } from './card-art.ts';

/**
 * Files from a paste or drop. The clipboard can carry the same picture as a
 * File, a URL string and text at once — only the File form is usable here, so
 * everything else is filtered and the paste handler decides whether plain
 * text (no media) proceeds into the textarea as usual.
 */
export function mediaFilesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && isNoteMediaMime(file.type)) files.push(file);
  }
  // Some drops surface the payload only in `files` (screenshots dragged from
  // some apps carry no per-item types), so take what this finds as well.
  if (!files.length) {
    for (const file of Array.from(transfer.files ?? [])) {
      if (isNoteMediaMime(file.type)) files.push(file);
    }
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
 * One pasted file in, one attachment out.
 *
 * GIFs and videos pass through byte-for-byte (the cap is the guard); other
 * images try verbatim first and fall back to the downscale path when they run
 * over it. Throws readable errors so the editor can surface them as a toast.
 */
export async function readNoteAttachment(file: File): Promise<VaultAttachment> {
  if (!isNoteMediaMime(file.type)) {
    throw new Error(`"${file.name || file.type || 'That file'}" is not a picture or a video.`);
  }
  const isVideo = file.type.startsWith('video/');
  const isGif = file.type === 'image/gif';
  const softCap = Math.floor(MAX_NOTE_ATTACHMENT_BYTES * 1.35); // base64 adds ~⅓

  if (!isVideo && !isGif && file.size > softCap) {
    // Too big to keep verbatim: re-encode. This drops the original format
    // (an animated png/webp loses frames, which is why this branch is never
    // taken for GIFs) but downscaled photos land far under the cap.
    try {
      const compressed = await readImageFile(file, MAX_NOTE_ATTACHMENT_BYTES);
      const mime = compressed.slice(5, compressed.indexOf(';'));
      return { id: newItemId(), mime: isNoteMediaMime(mime) ? mime : 'image/jpeg', dataUrl: compressed };
    } catch {
      throw new Error(
        `"${file.name || 'That image'}" is ${kb(file.size)} — above the ${kb(MAX_NOTE_ATTACHMENT_BYTES)} limit even after compressing.`,
      );
    }
  }

  if (file.size > softCap) {
    throw new Error(
      `"${file.name || file.type}" is ${kb(file.size)} — the limit is ${kb(MAX_NOTE_ATTACHMENT_BYTES)}.`,
    );
  }

  return { id: newItemId(), mime: file.type, dataUrl: await readDataUrl(file) };
}
