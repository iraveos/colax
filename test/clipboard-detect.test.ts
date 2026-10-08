import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/ui/useClipboardWatcher.ts';
import { formatLoginCompact, formatLoginForClipboard } from '../src/ui/login-format.ts';

/**
 * The reported bug: copy an email and a password, and no login appeared.
 *
 * The cause was that detect() only understood a bare two-line pair or a single
 * `email: password` line. The labelled block that Colax itself writes — and that
 * this detector now reads — was invisible to it, so the most obvious thing to
 * copy (copy a login out of Colax, paste it back) produced nothing.
 */

test('a bare two-line email and password is detected', () => {
  assert.deepEqual(detect('me@x.com\nhunter2'), { username: 'me@x.com', password: 'hunter2' });
});

test('a bare two-line pair works in either order', () => {
  assert.deepEqual(detect('hunter2\nme@x.com'), { username: 'me@x.com', password: 'hunter2' });
});

test('a single email: password line is detected', () => {
  assert.deepEqual(detect('me@x.com: hunter2'), { username: 'me@x.com', password: 'hunter2' });
});

test('labelled email and password lines are detected', () => {
  assert.deepEqual(detect('email: me@x.com\npassword: hunter2'), {
    username: 'me@x.com',
    password: 'hunter2',
  });
});

test('common label spellings all work', () => {
  for (const user of ['email', 'username', 'user', 'login', 'e-mail']) {
    for (const pass of ['password', 'pass', 'pwd']) {
      assert.deepEqual(
        detect(`${user}: me@x.com\n${pass}: hunter2`),
        { username: 'me@x.com', password: 'hunter2' },
        `${user}/${pass}`,
      );
    }
  }
});

test('a full labelled block keeps the title, url and notes', () => {
  const out = detect(
    [
      'title: GitHub',
      'email: me@x.com',
      'url: https://github.com',
      'notes: work account',
      'password: hunter2',
    ].join('\n'),
  );
  assert.deepEqual(out, {
    username: 'me@x.com',
    password: 'hunter2',
    url: 'https://github.com',
    title: 'GitHub',
    notes: 'work account',
  });
});

test('the format the app copies is the format the detector reads', () => {
  // The round trip that was broken. Copy a login out of Colax, paste it back,
  // and it must be recognised — otherwise the feature cannot even be tested on
  // the app's own output.
  const block = formatLoginForClipboard({
    title: 'GitHub',
    username: 'me@x.com',
    password: 'hunter2',
    url: 'https://github.com',
    notes: 'work account',
  });
  const out = detect(block);
  assert.ok(out, 'the app’s own clipboard format must be detected');
  assert.equal(out.username, 'me@x.com');
  assert.equal(out.password, 'hunter2');
  assert.equal(out.url, 'https://github.com');
  assert.equal(out.title, 'GitHub');
});

test('a bare domain gets an https prefix rather than being dropped', () => {
  const out = detect('email: me@x.com\npassword: hunter2\nurl: github.com');
  assert.equal(out?.url, 'https://github.com');
});

test('labels are matched case-insensitively and with loose spacing', () => {
  assert.deepEqual(detect('EMAIL:   me@x.com\nPassWord:  hunter2'), {
    username: 'me@x.com',
    password: 'hunter2',
  });
});

test('a labelled block with no password still offers the email', () => {
  // An email alone is half a login: worth an offer dialog, never an auto-save
  // (the watcher gates that separately). The password comes back empty rather
  // than absent so callers need no second shape.
  assert.deepEqual(detect('title: GitHub\nemail: me@x.com'), {
    username: 'me@x.com',
    password: '',
    title: 'GitHub',
  });
});

test('a lone address is detected without a password', () => {
  assert.deepEqual(detect('me@x.com'), { username: 'me@x.com', password: '' });
});

test('a lone non-address word is not a login', () => {
  // Bare words are too weak a signal: without an @ there is no telling an
  // email from any other copied word.
  assert.equal(detect('github'), null);
});

test('a labelled block with no username is not a login', () => {
  assert.equal(detect('title: GitHub\npassword: hunter2'), null);
});

test('prose with a colon in it never invents a password', () => {
  // The dangerous case: a block of notes that happens to contain "label: value"
  // pairs. Only the labels we know about are read, and both halves must be
  // present, so notes cannot masquerade as a credential.
  assert.equal(detect('subject: lunch\ntime: 12:30\nplace: cafe'), null);
});

test('a very short password is rejected rather than saved', () => {
  assert.equal(detect('email: me@x.com\npassword: 123'), null);
});

test('a url alone is not a login', () => {
  assert.equal(detect('https://github.com'), null);
});

test('an empty clipboard is not a login', () => {
  assert.equal(detect(''), null);
  assert.equal(detect('   \n  '), null);
});

test('an enormous block is refused rather than parsed', () => {
  assert.equal(detect('x'.repeat(5000)), null);
});

test('a duplicated label keeps the first value', () => {
  // Two "password:" lines means the text is not a clean credential block;
  // taking the first is predictable, and taking the last would let a trailing
  // line override what the user actually copied.
  assert.deepEqual(detect('email: me@x.com\npassword: first-one\npassword: second-one'), {
    username: 'me@x.com',
    password: 'first-one',
  });
});

test('a short password is still rejected when labelled', () => {
  // 6 characters is the floor the unlabelled path has always used, and a
  // labelled block gets the same treatment. Two labelled lines must not become
  // a login just because the password is too short to be plausible.
  assert.equal(detect('email: me@x.com\npassword: abc12'), null);
});

test('the compact share format round-trips, title included', () => {
  // Three lines: a bare title over the labelled pair. This is what per-login
  // Share copies, so a friend pasting it into their Colax must get a login.
  const block = formatLoginCompact({ title: 'GitHub', username: 'me@x.com', password: 'hunter2' });
  assert.equal(block, 'GitHub\nemail: me@x.com\npassword: hunter2');
  assert.deepEqual(detect(block), {
    username: 'me@x.com',
    password: 'hunter2',
    title: 'GitHub',
  });
});

test('a bare leading line becomes the title only when alone', () => {
  assert.deepEqual(detect('GitHub\nemail: me@x.com\npassword: hunter2')?.title, 'GitHub');
  // Two stray lines is prose with credentials inside: creds still parse, but
  // no line is promoted to a title.
  const prose = detect('some notes here\nand more\nemail: me@x.com\npassword: hunter2');
  assert.equal(prose?.username, 'me@x.com');
  assert.equal(prose?.title, undefined);
});

test('a labelled title beats a bare leading line', () => {
  const out = detect('Stray line\ntitle: Real Name\nemail: me@x.com\npassword: hunter2');
  // Two unlabelled lines means no bare title; the labelled one still wins.
  assert.equal(out?.title, 'Real Name');
});
