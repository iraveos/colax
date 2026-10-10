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
  loginShowsMail,
  mailboxUsable,
  maskEmail,
  matchesLogin,
  normaliseHost,
  planMailLinkedOnly,
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

test('the linked-only pass switches off exactly the logins that are not linked', () => {
  const accounts = [{ address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop', enabled: true }];
  const items = [
    { id: 'owner', username: 'Me@Gmail.com', showMail: true },
    { id: 'plain', username: 'other@else.com', showMail: true },
    { id: 'blank', username: '   ', showMail: true },
    { id: 'already', username: 'other@else.com', showMail: false },
  ];
  // The linked login is left alone; everything else that is still on goes off.
  assert.deepEqual(planMailLinkedOnly(items, accounts), ['plain', 'blank']);
  assert.deepEqual(planMailLinkedOnly([{ id: 'x', username: 'plain@else.com', showMail: true }], accounts), ['x']);
  // With no *usable* mailbox there is nothing to be linked to, so the pass
  // decides nothing rather than switching a whole vault's mail off.
  assert.deepEqual(planMailLinkedOnly(items, []), []);
  assert.deepEqual(planMailLinkedOnly(items, [{ address: 'me@gmail.com', appPassword: '  ' }]), []);
  assert.deepEqual(planMailLinkedOnly(items, [{ address: 'me@gmail.com', appPassword: 'x', enabled: false }]), []);
});

test('one connected mailbox puts Messages on the linked login, and nowhere else', () => {
  const accounts = [{ address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop', enabled: true }];
  // The login the mailbox was connected for, whatever it is called and whatever
  // case it was typed in: the linkage is the whole qualification.
  assert.equal(loginShowsMail({ username: 'me@gmail.com', showMail: false }, accounts), false, 'switched off by hand still wins');
  assert.equal(loginShowsMail({ username: 'other@else.com', showMail: false }, accounts), false);
  assert.equal(loginShowsMail({ username: '', showMail: false }, accounts), false);
  assert.equal(loginShowsMail({ username: '   ', showMail: false }, accounts), false);
});

test('a login switched on by hand shows Messages without being linked', () => {
  const accounts = [{ address: 'me@gmail.com', appPassword: 'x', enabled: true }];
  // The one deliberate escape hatch: the switch in the login editor.
  assert.equal(loginShowsMail({ username: 'other@else.com', showMail: true }, accounts), true);
});

test('a channel that hides mail wins over every other qualification', () => {
  const accounts = [{ address: 'me@gmail.com', appPassword: 'x', enabled: true }];
  assert.equal(loginShowsMail({ username: 'me@gmail.com', showMail: true }, accounts, false), false);
  assert.equal(loginShowsMail({ username: 'other@else.com', showMail: true }, accounts, false), false);
});

test('an unusable mailbox qualifies nobody, however it is configured', () => {
  const linked = { username: 'me@gmail.com', showMail: false };
  assert.equal(loginShowsMail(linked, []), false);
  assert.equal(loginShowsMail(linked, [{ address: 'me@gmail.com', appPassword: '   ', enabled: true }]), false);
  assert.equal(loginShowsMail(linked, [{ address: 'me@gmail.com', appPassword: 'x', enabled: false }]), false);
  assert.equal(loginShowsMail(linked, [{ address: '  ', appPassword: 'x', enabled: true }]), false);
  // Spaces are Google's own display format for app passwords, not a typo — and
  // the comparison is normalised on both sides, so a pasted address still links.
  assert.equal(
    loginShowsMail(
      { username: ' Me@Gmail.com ', showMail: true },
      [{ address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop', enabled: true }],
    ),
    true,
    'pasted spaces and stray whitespace are normalised, not rejected',
  );
  assert.equal(mailboxUsable({ address: 'a@b.c', appPassword: 'x' }), true, 'enabled defaults to true');
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