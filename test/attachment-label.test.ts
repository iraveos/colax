import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentFileName, attachmentSizeLabel } from '../src/ui/attachment-label.ts';
import type { VaultAttachment } from '../src/vault/types.ts';

const dataUrl = (mime: string, bytes: number): string =>
  `data:${mime};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;

const attachment = (mime: string, bytes = 1000, name?: string): VaultAttachment => ({
  id: 'a1',
  mime,
  dataUrl: dataUrl(mime, bytes),
  ...(name ? { name } : {}),
});

test('a stored name wins, and old records get a sensible extension', () => {
  assert.equal(attachmentFileName(attachment('application/pdf', 100, 'recovery codes.pdf'), 0), 'recovery codes.pdf');
  assert.equal(attachmentFileName(attachment('application/pdf'), 2), 'attachment-3.pdf');
  assert.equal(attachmentFileName(attachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 0), 'attachment-1.docx');
  assert.equal(attachmentFileName(attachment('application/octet-stream'), 0), 'attachment-1.octetstream');
});

test('attachment sizes read as KB and MB, not raw bytes', () => {
  assert.equal(attachmentSizeLabel(attachment('text/plain', 500)), '1 KB');
  assert.equal(attachmentSizeLabel(attachment('text/plain', 5000)), '5 KB');
  assert.equal(attachmentSizeLabel(attachment('application/pdf', 2_500_000)), '2.5 MB');
  assert.equal(attachmentSizeLabel(attachment('video/mp4', 12_000_000)), '12 MB');
});
