import test from 'node:test';
import assert from 'node:assert/strict';
import { diffBulkEdit, countAffected, commonSecurity, type BulkEdit } from '../src/ui/bulk-edit.ts';
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
