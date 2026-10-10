import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectInlineImages,
  decodePartBytes,
  decodeQuotedPrintable,
  gmailHexOf,
  imapUidOf,
  isConnectionError,
  pickHtmlPart,
  pickTextPart,
  stripHtml,
} from '../src/lib/mail-text.ts';

test('the feed id tail is the Gmail hex id', () => {
  assert.equal(gmailHexOf('tag:gmail.google.com,2004:18f3ab02cd'), '18f3ab02cd');
  assert.equal(gmailHexOf('plain-hex'), null);
  assert.equal(gmailHexOf(''), null);
  assert.equal(gmailHexOf(null), null);
});

test('plain text wins over html, attachments never count', () => {
  const picked = pickTextPart({
    type: 'multipart/mixed',
    childNodes: [
      { type: 'text/html', part: '1', parameters: {} },
      { type: 'text/plain', part: '2', parameters: {} },
      { type: 'text/plain', part: '3', disposition: 'attachment', parameters: {} },
    ],
  });
  assert.deepEqual(picked, { part: '2', html: false });
  assert.deepEqual(pickTextPart({ type: 'text/html', part: '1', parameters: {} }), { part: '1', html: true });
  assert.equal(pickTextPart(null), null);
});

test('quoted-printable decodes soft breaks and hex escapes', () => {
  const bytes = new TextEncoder().encode('Hello=\r\nWorld=21=C3=A9');
  assert.equal(new TextDecoder().decode(decodeQuotedPrintable(bytes)), 'HelloWorld!é');
});

test('base64 parts decode with their charset, not as UTF-8', () => {
  // "café" with é as windows-1256 0xE9 (invalid UTF-8 on its own), base64-wrapped.
  const raw = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
  const wrapped = new TextEncoder().encode(Buffer.from(raw).toString('base64'));
  assert.equal(decodePartBytes(wrapped, 'base64', 'windows-1256'), 'café');
  const qp = new TextEncoder().encode('caf=C3=A9');
  assert.equal(decodePartBytes(qp, 'quoted-printable', 'utf-8'), 'café');
  const plain = new TextEncoder().encode('hello');
  assert.equal(decodePartBytes(plain, '7bit', 'utf-8'), 'hello');
});

test('imap ids parse to UIDs, everything else does not', () => {
  assert.equal(imapUidOf('imap:4821'), 4821);
  assert.equal(imapUidOf('tag:gmail.google.com,2004:18f3ab02cd'), null);
  assert.equal(imapUidOf('imap:0'), null);
  assert.equal(imapUidOf('imap:abc'), null);
  assert.equal(imapUidOf(''), null);
  assert.equal(imapUidOf(null), null);
});

test('html part and inline images are picked out of the structure', () => {
  const tree = {
    type: 'multipart/related',
    childNodes: [
      {
        type: 'multipart/alternative',
        childNodes: [
          { type: 'text/plain', part: '1.1', parameters: {} },
          { type: 'text/html', part: '1.2', parameters: {} },
        ],
      },
      { type: 'image/png', part: '2', id: '<logo123>', parameters: {}, size: 42000 },
      { type: 'image/jpeg', part: '3', disposition: 'attachment', parameters: {} },
    ],
  };
  assert.deepEqual(pickHtmlPart(tree), { part: '1.2' });
  assert.deepEqual(collectInlineImages(tree), [
    { part: '2', cid: 'logo123', mime: 'image/png', size: 42000 },
  ]);
  assert.equal(pickHtmlPart({ type: 'text/plain', part: '1', parameters: {} }), null);
});

test('html strips to readable text without scripts', () => {
  const out = stripHtml('<style>.x{}</style><p>Hello <b>World</b></p><!-- c --><p>Line&nbsp;2 &amp; co</p>');
  assert.equal(out, 'Hello World\nLine 2 & co');
});

test('images vanish whole, alt text included', () => {
  const out = stripHtml('<p>Hi</p><img src="cid:logo" alt="Company logo"><p>Bye</p>');
  assert.equal(out, 'Hi\nBye');
  assert.ok(!out.includes('logo'), 'no stray alt words left behind');
});

test('only dead sockets count as connection errors', () => {
  assert.equal(isConnectionError(new Error('Connection not available')), true);
  assert.equal(isConnectionError(new Error('socket hang up')), true);
  assert.equal(isConnectionError(Object.assign(new Error('read failed'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isConnectionError(new Error('Invalid credentials')), false);
  assert.equal(isConnectionError(new Error('Message not found')), false);
  assert.equal(isConnectionError(null), false);
});

test('out-of-range entities drop out instead of throwing', () => {
  assert.equal(stripHtml('<p>A&#99999999;B&#x110000;C&#65;D</p>'), 'ABCAD');
});

test('links unwrap to text, bare long URLs drop out', () => {
  const long = `https://tracker.example.com/click?${'x'.repeat(80)}`;
  assert.equal(stripHtml(`<p>Read <a href="${long}">the report</a> today</p>`), 'Read the report today');
  assert.equal(stripHtml(`<p>Visit <a href="${long}">${long}</a> now</p>`), 'Visit now');
  assert.equal(stripHtml('<p>See <a href="https://x.co/a">https://x.co/a</a></p>'), 'See https://x.co/a');
  assert.equal(stripHtml('<p>Go <a href="https://x.co"></a> home</p>'), 'Go home');
});
