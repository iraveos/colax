import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePartBytes,
  decodeQuotedPrintable,
  gmailDecimalOf,
  gmailDecimalsOf,
  gmailHexOf,
  gmailRawFallback,
  pickTextPart,
  stripHtml,
} from '../src/lib/mail-text.ts';

test('the feed id tail is the Gmail hex id', () => {
  assert.equal(gmailHexOf('tag:gmail.google.com,2004:18f3ab02cd'), '18f3ab02cd');
  assert.equal(gmailHexOf('plain-hex'), null);
  assert.equal(gmailHexOf(''), null);
  assert.equal(gmailHexOf(null), null);
});

test('hex converts to the decimal X-GM-MSGID', () => {
  assert.equal(gmailDecimalOf('18f3ab02cd'), String(BigInt('0x18f3ab02cd')));
  assert.equal(gmailDecimalOf('zzz'), null);
});

test('decimal tails try decimal first, hex-decoded second', () => {
  // A 19-digit feed tail is already decimal — hex-decoding it would address nothing.
  assert.deepEqual(gmailDecimalsOf('1699871234567890123'), ['1699871234567890123']);
  // Short digit tails are ambiguous: decimal first, then the hex reading.
  assert.deepEqual(gmailDecimalsOf('1234'), ['1234', String(BigInt('0x1234'))]);
  // Lettered tails only have the hex reading.
  assert.deepEqual(gmailDecimalsOf('18f3ab02cd'), [String(BigInt('0x18f3ab02cd'))]);
  assert.deepEqual(gmailDecimalsOf('junk!'), []);
  assert.deepEqual(gmailDecimalsOf(null), []);
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

test('the fallback query quotes sender and subject', () => {
  assert.equal(
    gmailRawFallback('Boss <boss@work.com>', 'Q3 "results"'),
    'from:"boss@work.com" subject:"Q3 \\"results\\""',
  );
  assert.equal(gmailRawFallback('', '  '), null);
  assert.equal(gmailRawFallback(null, null), null);
});

test('html strips to readable text without scripts', () => {
  const out = stripHtml('<style>.x{}</style><p>Hello <b>World</b></p><!-- c --><p>Line&nbsp;2 &amp; co</p>');
  assert.equal(out, 'Hello World\nLine 2 & co');
});
