import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureToDraft,
  emailProvider,
  extractEmails,
  findSimilarTag,
  inspectCapture,
  knownSite,
  looksLikeEmail,
  looksLikePlaceholder,
  mailboxOwnedBy,
  maskEmail,
  matchesLogin,
  normaliseHost,
  siteNameFor,
} from '../src/vault/site-intel.ts';

test('a host is lowercased and loses a leading www', () => {
  assert.equal(normaliseHost('WWW.GitHub.com'), 'github.com');
  assert.equal(normaliseHost(null), '');
});

test('a subdomain matches its parent, longest match wins', () => {
  assert.equal(knownSite('mail.google.com')?.name, 'Gmail');
  assert.equal(knownSite('accounts.google.com')?.name, 'Google');
  assert.equal(knownSite('github.com')?.name, 'GitHub');
  assert.equal(knownSite('notgoogle.com'), null);
  // A host that merely ends in the same letters must not match.
  assert.equal(knownSite('evilgoogle.com'), null);
});

test('an unknown host falls back to the registrable label', () => {
  assert.equal(siteNameFor('login.acmecorp.co.uk'), 'Acmecorp');
  assert.equal(siteNameFor('acmecorp.com'), 'Acmecorp');
  assert.equal(siteNameFor('shop.acme.io'), 'Acme');
});

test('with no host at all the page title is used', () => {
  assert.equal(siteNameFor('', 'Acme Portal — Sign in'), 'Acme Portal');
});

test('email detection needs a dot in the domain', () => {
  assert.equal(looksLikeEmail('a@b.co'), true);
  assert.equal(looksLikeEmail('a@b'), false);
  assert.equal(looksLikeEmail('not an email'), false);
});

test('bulk paste: one address per line, in paste order', () => {
  assert.deepEqual(extractEmails('a@x.com\nb@y.org\nc@z.net'), ['a@x.com', 'b@y.org', 'c@z.net']);
});

test('bulk paste: commas, semicolons, spaces and wrapping all work', () => {
  assert.deepEqual(extractEmails('a@x.com, b@y.org; c@z.net'), ['a@x.com', 'b@y.org', 'c@z.net']);
  assert.deepEqual(extractEmails('<a@x.com>, "b@y.org";'), ['a@x.com', 'b@y.org']);
});

test('a login whose username is a mailbox address owns that mailbox', () => {
  const accounts = [{ id: 'gm_1', address: 'Me@Gmail.com' }];
  assert.equal(mailboxOwnedBy('me@gmail.com', accounts)?.id, 'gm_1');
  assert.equal(mailboxOwnedBy('someone@else.com', accounts), null);
  assert.equal(mailboxOwnedBy('  ', accounts), null);
  assert.equal(mailboxOwnedBy('me@gmail.com', []), null);
});

test('sender matching is exact on address, loose on name', () => {
  assert.equal(matchesLogin({ email: 'a@x.com', author: 'A' }, 'a@x.com'), true);
  assert.equal(matchesLogin({ email: 'b@x.com', author: 'Anna Smith' }, 'anna'), true);
  assert.equal(matchesLogin({ email: 'b@x.com', author: 'Bob' }, 'a@x.com'), false);
  assert.equal(matchesLogin({ email: 'b@x.com', author: 'Bob' }, ''), false);
});

test('masking keeps two letters and the domain, hides the rest', () => {
  assert.equal(maskEmail('hmm34909@gmail.com'), 'hm••••••@gmail.com');
  assert.equal(maskEmail('ab@x.co'), 'a•@x.co');
  assert.equal(maskEmail('a@x.co'), 'a•@x.co');
  assert.equal(maskEmail('not-an-email'), 'not-an-email');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
});

test('bulk paste: junk is dropped and dupes collapse case-insensitively', () => {
  assert.deepEqual(extractEmails('hello\nA@x.com\na@X.COM\nnot-an-email\na@b'), ['A@x.com']);
  assert.deepEqual(extractEmails(''), []);
  assert.deepEqual(extractEmails(null), []);
});

test('placeholders and masking runs are rejected, real values are not', () => {
  assert.equal(looksLikePlaceholder('••••••••'), true);
  assert.equal(looksLikePlaceholder('********'), true);
  assert.equal(looksLikePlaceholder('Password'), true);
  assert.equal(looksLikePlaceholder('correct horse battery staple'), true);
  assert.equal(looksLikePlaceholder('Tr0ub4dor&3'), false);
  assert.equal(looksLikePlaceholder('jsmith'), false);
});

test('similar tags reuse an existing entry instead of duplicating it', () => {
  const catalogue = [{ id: 'tg_1', name: 'Email' }, { id: 'tg_2', name: 'Work stuff' }];
  assert.equal(findSimilarTag('emails', catalogue)?.id, 'tg_1');
  assert.equal(findSimilarTag('WORK', catalogue)?.id, 'tg_2');
  assert.equal(findSimilarTag('streaming', catalogue), null);
});

test('a gmail signup on google files under Google, not Gmail', () => {
  const insight = inspectCapture(
    { url: 'https://accounts.google.com/signup', username: 'me@gmail.com', password: 'Tr0ub4dor&3' },
    [],
  );
  assert.equal(insight.verdict, 'save');
  assert.equal(insight.siteName, 'Google');
  // Both the site tag and the provider tag collapse to the same single entry.
  assert.deepEqual(
    insight.suggestedTags.map((tag) => tag.name),
    ['Google'],
  );
});

test('an unknown provider falls back to its own domain as a tag', () => {
  const insight = inspectCapture(
    { url: 'https://acmecorp.com/login', username: 'me@acmecorp.com', password: 'Tr0ub4dor&3' },
    [],
  );
  assert.deepEqual(
    insight.suggestedTags.map((tag) => tag.name),
    ['Acmecorp'],
  );
});

test('an existing similar tag is preferred over creating a new one', () => {
  const insight = inspectCapture(
    { url: 'https://github.com/login', username: 'octocat', password: 'Tr0ub4dor&3' },
    [{ id: 'tg_dev', name: 'Development' }, { id: 'tg_social', name: 'Social' }],
  );
  assert.deepEqual(
    insight.suggestedTags.map((tag) => tag.id),
    ['tg_dev'],
  );
});

test('mismatched password fields are never offered for saving', () => {
  const insight = inspectCapture({
    url: 'https://acme.com/signup',
    username: 'me@acme.com',
    password: 'Tr0ub4dor&3',
    passwordConfirm: 'something-else',
  });
  assert.equal(insight.verdict, 'mismatch');
  assert.equal(insight.passwordsMismatch, true);
});

test('an absent confirm field is not a mismatch', () => {
  const insight = inspectCapture({
    url: 'https://acme.com/login',
    username: 'me',
    password: 'Tr0ub4dor&3',
    passwordConfirm: '',
  });
  assert.equal(insight.verdict, 'save');
});

test('an all-placeholder capture is not offered', () => {
  const insight = inspectCapture({
    url: 'https://acme.com/login',
    username: 'username',
    password: 'Password',
  });
  assert.equal(insight.verdict, 'placeholder');
});

test('an empty capture is not offered', () => {
  assert.equal(inspectCapture({ url: 'https://acme.com/login' }).verdict, 'empty');
});

test('email providers are recognised', () => {
  assert.equal(emailProvider('me@proton.me')?.tag, 'Email');
  assert.equal(emailProvider('me@nowhere.example'), null);
});

test('an accepted capture becomes a usable draft', () => {
  const capture = { url: 'https://github.com/login', username: 'octocat', password: 'Tr0ub4dor&3' };
  const draft = captureToDraft(capture, inspectCapture(capture));
  assert.deepEqual(draft, {
    title: 'GitHub',
    username: 'octocat',
    password: 'Tr0ub4dor&3',
    url: 'https://github.com',
  });
});