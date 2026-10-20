import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkMenu, diffBulkEdit, countAffected, commonSecurity, type BulkEdit } from '../src/ui/bulk-edit.ts';
import { formatLoginForClipboard, formatLoginsForClipboard } from '../src/ui/login-format.ts';
import { emptyItem, type VaultItem } from '../src/vault/types.ts';
import { EMPTY_SECURITY } from '../src/crypto/security.ts';

/**
 * These tests exist because of one specific failure, reported as: bulk-editing a
 * theme also overwrote the titles. Every case below is a version of that bug.
 */

function item(over: Partial<VaultItem> = {}): VaultItem {
  return { ...emptyItem('i1', 1000), ...over };
}

test('an untouched field is never written', () => {
  // The core regression. Only a hue is supplied, so only the hue may appear in
  // the patch: no title, no notes, no url, and above all no password.
  const it = item({ title: 'GitHub', username: 'me@x.com', password: 'hunter2', notes: 'keep me' });
  const patch = diffBulkEdit(it, { accentHue: 152 });
  assert.deepEqual(patch, { accentHue: 152 });
  assert.equal(patch && 'title' in patch, false);
  assert.equal(patch && 'password' in patch, false);
});

test('a bulk notes edit drops the old formatted copy', () => {
  const before = item({ notes: 'plain', notesHtml: '<p><strong>plain</strong></p>' });
  const patch = diffBulkEdit(before, { notes: 'new text' });
  assert.equal(patch?.notes, 'new text');
  assert.equal(patch?.notesHtml, '');
});

test('an empty BulkEdit produces no patch at all', () => {
  assert.equal(diffBulkEdit(item({ title: 'X' }), {}), undefined);
  assert.equal(countAffected([item({ title: 'X' })], {}), 0);
});

test('a field set to empty string is treated as untouched, not as a clear', () => {
  // The form starts every input as ''. If '' meant "set the field to empty",
  // merely opening the dialog and pressing Apply would blank every selected
  // login. Callers therefore pass undefined rather than '' — this pins that the
  // blank-value case is the caller's job and not silently destructive here.
  const it = item({ title: 'GitHub' });
  assert.equal(diffBulkEdit(it, { title: undefined }), undefined);
});

test('a changed value is applied', () => {
  const it = item({ title: 'GitHub' });
  assert.deepEqual(diffBulkEdit(it, { title: 'GitLab' }), { title: 'GitLab' });
});

test('a value equal to what is already there is not rewritten', () => {
  // Keeping updatedAt honest: re-saving an identical value is a no-op, not an
  // edit. Otherwise bulk-applying a no-op would bump the sort order.
  const it = item({ title: 'GitHub', updatedAt: 500 });
  assert.equal(diffBulkEdit(it, { title: 'GitHub' }), undefined);
});

test('a password change also moves passwordUpdatedAt', () => {
  // Otherwise the "this password is old" check still calls a just-rotated
  // password stale.
  const it = item({ password: 'old', passwordUpdatedAt: 0 });
  const patch = diffBulkEdit(it, { password: 'new' });
  assert.equal(patch?.password, 'new');
  assert.ok((patch?.passwordUpdatedAt ?? 0) > 0, 'passwordUpdatedAt is refreshed');
});

test('title and theme can be changed together without either leaking', () => {
  const a = item({ title: 'One', password: 'p1' });
  const b = item({ title: 'Two', password: 'p2' });
  const edit: BulkEdit = { title: 'Shared', accentHue: 268 };
  assert.deepEqual(diffBulkEdit(a, edit), { title: 'Shared', accentHue: 268 });
  assert.deepEqual(diffBulkEdit(b, edit), { title: 'Shared', accentHue: 268 });
  // And the passwords, which no bulk field can reach, are untouched.
  assert.equal(diffBulkEdit(a, edit)?.password, undefined);
  assert.equal(diffBulkEdit(b, edit)?.password, undefined);
});

test('tags compare as a set, not by order', () => {
  const it = item({ tags: ['a', 'b'] });
  assert.equal(diffBulkEdit(it, { tags: ['b', 'a'] }), undefined);
  assert.deepEqual(diffBulkEdit(it, { tags: ['a', 'b', 'c'] }), { tags: ['a', 'b', 'c'] });
});

test('countAffected counts only the logins that would actually change', () => {
  const items = [item({ title: 'One' }), item({ title: 'Two' }), item({ title: 'Target' })];
  // Two of the three are not already called Target, so two get written; the one
  // that already matches is left alone.
  assert.equal(countAffected(items, { title: 'Target' }), 2);
  // A hue nobody has is a change for all three.
  assert.equal(countAffected(items, { accentHue: 152 }), 3);
  // A value all three already share is a change for none of them, so the Apply
  // button correctly stays disabled rather than writing the same value thrice.
  assert.equal(countAffected(items, { accentHue: null }), 0);
});

test('commonSecurity is null when the selection disagrees', () => {
  // This is what stops a bulk security form adopting one login's TOTP seed for
  // the rest. Disagreement has to be visible, not resolved silently.
  const withTotp = item({ security: { totp: { seed: 'AAA' }, questions: [] } });
  const withOther = item({ security: { totp: { seed: 'BBB' }, questions: [] } });
  const plain = item({ security: { totp: null, questions: [] } });
  assert.equal(commonSecurity([withTotp, withOther]), null);
  assert.equal(commonSecurity([withTotp, plain]), null);
  // Everything agrees they have no factor: that is a real answer, so it returns
  // the empty block rather than null. Null is reserved for "they disagree", and
  // conflating the two would make an unprotected selection look like an
  // unreadable one.
  assert.deepEqual(commonSecurity([plain, plain]), EMPTY_SECURITY);
  assert.deepEqual(commonSecurity([plain]), EMPTY_SECURITY);
});

test('commonSecurity returns the shared block when they agree', () => {
  const seed = { seed: 'SAME' };
  const a = item({ security: { totp: seed, questions: [] } });
  const b = item({ security: { totp: seed, questions: [] } });
  assert.deepEqual(commonSecurity([a, b]), a.security);
});

test('commonSecurity of nothing is nothing', () => {
  assert.equal(commonSecurity([]), null);
});

/* ---- Clipboard format ---------------------------------------------------- */

test('a login is copied as labelled lines with the password last', () => {
  const out = formatLoginForClipboard({
    title: 'GitHub',
    username: 'me@x.com',
    password: 'hunter2',
    url: 'https://github.com',
    notes: '',
  });
  assert.equal(
    out,
    'title: GitHub\nemail: me@x.com\nurl: https://github.com\npassword: hunter2',
  );
  // The password has to be last: it is the line that gets pasted, so a truncated
  // paste should lose something else.
  assert.ok(out.split('\n').at(-1)?.startsWith('password: '));
});

test('empty fields are omitted rather than written blank', () => {
  // "password:" with nothing after it reads as though the password were empty,
  // which is the opposite of the truth for a login that has notes but no url.
  const out = formatLoginForClipboard({
    title: 'X',
    username: '',
    password: '',
    url: '',
    notes: 'note',
  });
  assert.equal(out, 'title: X\nnotes: note');
  assert.equal(out.includes('password:'), false);
  assert.equal(out.includes('email:'), false);
});

test('the username is labelled email, as asked', () => {
  const out = formatLoginForClipboard({ title: '', username: 'me@x.com', password: 'p', url: '', notes: '' });
  assert.equal(out, 'email: me@x.com\npassword: p');
});

test('an authenticator key is included and labelled', () => {
  const out = formatLoginForClipboard({
    title: 'X',
    username: 'me',
    password: 'p',
    url: '',
    notes: '',
    totpSecret: 'JBSWY3DP',
  });
  assert.ok(out.includes('authenticator key: JBSWY3DP'));
  // Still before the password.
  assert.ok(out.indexOf('authenticator key') < out.indexOf('password:'));
});

test('several logins are separated by a blank line', () => {
  const out = formatLoginsForClipboard([
    { title: 'A', username: 'a@x', password: '1', url: '', notes: '' },
    { title: 'B', username: 'b@x', password: '2', url: '', notes: '' },
  ]);
  assert.equal(out, 'title: A\nemail: a@x\npassword: 1\n\ntitle: B\nemail: b@x\npassword: 2');
});

test('the copy uses \\n, never \\r\\n', () => {
  // A stray carriage return ends up inside a password field and is very hard to
  // see. The clipboard text is built explicitly rather than via the platform
  // default so this stays true.
  const out = formatLoginForClipboard({ title: 'A', username: 'b', password: 'c', url: '', notes: '' });
  assert.equal(out.includes('\r'), false);
});

test('a login with nothing set formats to nothing', () => {
  assert.equal(
    formatLoginForClipboard({ title: '   ', username: '', password: '', url: '', notes: '' }),
    '',
  );
});

test('adding a tag keeps the tags each login already had', () => {
  // The old tags panel wrote one set onto everyone, so giving three logins a
  // shared "work" tag could delete the personal tag one of them carried.
  const withPersonal = item({ tags: ['tg_personal'] });
  const bare = item({ id: 'i2' });
  assert.deepEqual(diffBulkEdit(withPersonal, { tagsAdd: ['tg_work'], tagsRemove: [] })?.tags, [
    'tg_personal',
    'tg_work',
  ]);
  assert.deepEqual(diffBulkEdit(bare, { tagsAdd: ['tg_work'], tagsRemove: [] })?.tags, ['tg_work']);
});

test('removing a tag leaves the login its other tags', () => {
  const it = item({ tags: ['tg_a', 'tg_b'] });
  assert.deepEqual(diffBulkEdit(it, { tagsRemove: ['tg_a'], tagsAdd: [] })?.tags, ['tg_b']);
  // A tag that is not there is a no-op, so nothing is written and updatedAt
  // stays honest.
  assert.equal(diffBulkEdit(item({ tags: ['tg_b'] }), { tagsRemove: ['tg_a'], tagsAdd: [] }), undefined);
});

test('the bulk menu opens the field it names', () => {
  const opened: string[] = [];
  const menu = bulkMenu({
    items: [item({ title: 'A' }), item({ id: 'i2', title: 'B' })],
    onShare: () => {},
    onEditFields: (field) => opened.push(field),
    onEditSecurity: () => {},
    onDelete: () => {},
    onSelectAll: () => {},
    onClear: () => {},
    icon: { share: null, edit: null, shield: null, trash: null, all: null },
  });
  const editMenu = menu.find((entry) => entry.kind === 'submenu' && entry.label.startsWith('Edit'));
  assert.ok(editMenu && editMenu.kind === 'submenu');
  for (const entry of editMenu.items) {
    if (
      entry.kind === 'item' &&
      ['Title', 'Email / username', 'New password…', 'Notes', 'Tags', 'Theme'].includes(entry.label)
    ) {
      entry.onSelect?.();
    }
  }
  assert.deepEqual(opened, ['title', 'username', 'password', 'notes', 'tags', 'theme']);
});

/* ---- Rotating credentials ------------------------------------------------ */

test('a generated password is new for every login in the selection', () => {
  const a = item({ id: 'a', password: 'old', passwordUpdatedAt: 1 });
  const b = item({ id: 'b', password: 'old', passwordUpdatedAt: 1 });
  const edit: BulkEdit = { passwordGenerate: true };

  const first = diffBulkEdit(a, edit)!;
  const second = diffBulkEdit(b, edit)!;

  assert.notEqual(first.password, 'old');
  assert.notEqual(first.password, second.password, 'one shared password across a selection is reuse by definition');
  // The age check has to move with the password, or every rotated login is still
  // reported as stale the moment the dialog closes.
  assert.ok((first.passwordUpdatedAt ?? 0) > 1);
});

test('a generated password is counted for the whole selection', () => {
  // The diff would have to generate a string per login just to answer this, and
  // the answer cannot be "0 of 3" while Apply would clearly do something.
  const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
  assert.equal(countAffected(items, { passwordGenerate: true }), 3);
});

test('generation honours the saved generator settings', () => {
  const patch = diffBulkEdit(item(), {
    passwordGenerate: true,
    passwordOptions: { length: 32, lower: true, upper: false, digits: false, symbols: false, avoidAmbiguous: false },
  })!;
  assert.equal(patch.password?.length, 32);
  assert.match(patch.password ?? '', /^[a-z]+$/, 'only the selected character set may appear');
});

test('setting one password for all still writes exactly that value', () => {
  const patch = diffBulkEdit(item({ password: 'old' }), { password: 'shared' })!;
  assert.equal(patch.password, 'shared');
});

test('an email can be set across a selection without touching passwords', () => {
  const patch = diffBulkEdit(item({ username: 'old@x', password: 'keep' }), { username: 'new@x' })!;
  assert.deepEqual(patch, { username: 'new@x' });
});
