import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_MEDIA_BYTES,
  attachmentBytes,
  emptyItem,
  normaliseItem,
  normaliseNoteAttachments,
  noteMediaBudget,
  type VaultAttachment,
} from '../src/vault/types.ts';
import { historyEventsFor } from '../src/vault/storage.ts';

/** A data URL whose payload is approximately `bytes` long once decoded. */
const mediaUrl = (mime: string, bytes: number): string =>
  `data:${mime};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;

const attachment = (mime: string, bytes: number, id: string): VaultAttachment => ({
  id,
  mime,
  dataUrl: mediaUrl(mime, bytes),
});

test('attachmentBytes decodes the base64 overhead', () => {
  assert.equal(attachmentBytes(''), 0);
  assert.equal(attachmentBytes('data:image/png;not-base64'), 0);
  // ~5.33M base64 chars encode the 4 MB cap exactly.
  const bytes = attachmentBytes(mediaUrl('image/png', 500));
  assert.ok(bytes >= 500 && bytes < 520, `expected ~500, got ${bytes}`);
});

test('the media budget closes when the count or total is exhausted', () => {
  assert.deepEqual(noteMediaBudget([]), { slots: MAX_NOTE_ATTACHMENTS, bytes: MAX_NOTE_MEDIA_BYTES });
  const one = attachment('image/png', MAX_NOTE_ATTACHMENT_BYTES - 1000, 'a1');
  // One cap-sized attachment nearly fills the total budget: the count still
  // has room, but the second attachment of the same size does not.
  const budget = noteMediaBudget([one])!;
  assert.ok(budget.slots === MAX_NOTE_ATTACHMENTS - 1);
  // The total budget minus what the first attachment consumed.
  assert.ok(budget.bytes > 0 && budget.bytes < MAX_NOTE_MEDIA_BYTES);
  assert.ok(budget.bytes < MAX_NOTE_MEDIA_BYTES - attachmentBytes(one.dataUrl) + 8);
  const full: VaultAttachment[] = Array.from({ length: MAX_NOTE_ATTACHMENTS }, (_, index) =>
    attachment('image/png', 100, `full${index}`),
  );
  assert.equal(noteMediaBudget(full), null);
});

test('normaliseNoteAttachments keeps valid media and files, dropping the rest', () => {
  const good = attachment('image/png', 1000, 'keep1');
  const gif = attachment('image/gif', 1000, 'keep2');
  const video = attachment('video/mp4', 1000, 'keep3');
  const file: VaultAttachment = {
    id: 'keep4',
    mime: 'application/pdf',
    dataUrl: mediaUrl('application/pdf', 1000),
    name: 'recovery.pdf',
  };
  const brokenMime = { id: 'bad1', mime: 'image/png', dataUrl: 'data:text/html;base64,AAAA' };
  const badMime = { id: 'bad2', mime: 'not a mime', dataUrl: 'data:not a mime;base64,AAAA' };
  const oversized = attachment('image/png', MAX_NOTE_ATTACHMENT_BYTES + 5000, 'bad3');
  const junk = 'a string, not an attachment';
  const out = normaliseNoteAttachments([good, gif, video, file, brokenMime, badMime, oversized, junk, null]);
  assert.deepEqual(
    out.map((kept) => kept.id),
    ['keep1', 'keep2', 'keep3', 'keep4'],
  );
  assert.equal(out[3]?.name, 'recovery.pdf');
});

test('the attachment count cap lands before a 13th media', () => {
  const sixteen = Array.from({ length: 16 }, (_, index) => attachment('image/png', 100, `n${index}`));
  const out = normaliseNoteAttachments(sixteen);
  assert.equal(out.length, MAX_NOTE_ATTACHMENTS);
  assert.equal(out[out.length - 1]?.id, `n${MAX_NOTE_ATTACHMENTS - 1}`);
});

test('the total budget drops what would overflow it', () => {
  // Twelve attachments of 2 MB each exceed the 20 MB total: the ones past the
  // budget line are dropped by size, not just count.
  const heavy = Array.from({ length: MAX_NOTE_ATTACHMENTS }, (_, index) =>
    attachment('image/png', 2_000_000, `heavy${index}`),
  );
  const out = normaliseNoteAttachments(heavy);
  assert.ok(out.length < MAX_NOTE_ATTACHMENTS);
  const total = out.reduce((sum, kept) => sum + attachmentBytes(kept.dataUrl), 0);
  assert.ok(total <= MAX_NOTE_MEDIA_BYTES);
});

test('normaliseItem sanitises an old or hand-edited record', () => {
  const base = normaliseItem({ id: 'x', attachments: [attachment('image/png', 100, 'ok')] });
  assert.equal(base.attachments?.length, 1);
  assert.equal(base.notesHtml, '');
  assert.deepEqual(normaliseItem({ id: 'x', attachments: 'junk' as never }).attachments, []);
  assert.deepEqual(normaliseItem({ id: 'x' }).attachments, []);
  // The empty shape carries the fields, so callers never branch on undefined.
  assert.deepEqual(emptyItem('y').attachments, []);
  assert.equal(emptyItem('y').notesHtml, '');
  assert.equal(normaliseItem({ id: 'x', notesHtml: '<p>hi</p>' }).notesHtml, '<p>hi</p>');
  assert.equal(normaliseItem({ id: 'x', notesHtml: 42 as never }).notesHtml, '');
});

test('history snapshots never carry the media', () => {
  const before = normaliseItem({
    ...emptyItem('m1'),
    title: 'With media',
    attachments: [attachment('video/mp4', 300_000, 'm1a')],
  });
  const after = normaliseItem({ ...before, title: 'Renamed', updatedAt: before.updatedAt + 1 });
  const events = historyEventsFor([before], [after], 123);
  const edited = events.find((event) => event.action === 'edited')!;
  assert.ok(edited, 'an edit that only renames still logs');
  assert.equal(edited.before!.attachments!.length, 0, 'media stays out of the plaintext prefs log');
  // A deleted login's snapshot is trimmable the same way: restoring keeps the
  // text but not the pictures.
  const deleted = historyEventsFor([before], [], 123).find((event) => event.action === 'deleted')!;
  assert.equal(deleted.before!.attachments!.length, 0);
});

test('a no-op media re-save stays out of the history log', () => {
  const item = normaliseItem({
    ...emptyItem('m2'),
    title: 'Same',
    attachments: [attachment('image/gif', 3000, 'm2a')],
  });
  const recheck = normaliseItem({ ...item, updatedAt: item.updatedAt + 1 });
  assert.deepEqual(historyEventsFor([item], [recheck], 123), []);
});
