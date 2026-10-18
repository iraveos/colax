import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessTokenUsable,
  buildAuthorizeUrl,
  hasOauthTokens,
  isHttpUrl,
  normaliseMailOAuth,
  oauthConfigUsable,
  OAUTH_PRESETS,
  oauthPresetById,
  parseTokenResponse,
  type MailOAuth,
} from '../src/lib/oauth.ts';

const GOOGLE = OAUTH_PRESETS.find((preset) => preset.id === 'google')!;

test('the authorize URL carries the whole code flow, PKCE included', () => {
  const url = buildAuthorizeUrl(
    {
      clientId: 'my-client-id',
      authUrl: 'https://provider.test/authorize?existing=1',
      scopes: 'mail.read mail.write',
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    { redirectUri: 'http://127.0.0.1:51234/', state: 'state-123', codeChallenge: 'challenge-abc' },
  );
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_id'), 'my-client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:51234/');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), 'state-123');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-abc');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('scope'), 'mail.read mail.write');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  // A provider's own query parameters survive the rewrite.
  assert.equal(parsed.searchParams.get('existing'), '1');
});

test('the authorize URL refuses anything that is not a real http(s) address', () => {
  const flow = { redirectUri: 'http://127.0.0.1:1/', state: 's', codeChallenge: 'c' };
  assert.equal(buildAuthorizeUrl({ clientId: 'x', authUrl: 'javascript:alert(1)', scopes: '' }, flow), '');
  assert.equal(buildAuthorizeUrl({ clientId: 'x', authUrl: 'not a url', scopes: '' }, flow), '');
  assert.equal(buildAuthorizeUrl({ clientId: '', authUrl: 'https://x.test/a', scopes: '' }, flow), '');
  assert.equal(
    buildAuthorizeUrl({ clientId: 'x', authUrl: 'https://x.test/a', scopes: '' }, { ...flow, redirectUri: 'file:///etc' }),
    '',
  );
});

test('a token response is parsed field by field, junk tolerated', () => {
  const now = 1_000_000;
  const full = parseTokenResponse(
    { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'mail' },
    now,
  );
  assert.deepEqual(full, { accessToken: 'at', refreshToken: 'rt', expiresAt: now + 3_600_000 });
  // No expiry is normal for some providers; the token still works.
  assert.deepEqual(parseTokenResponse({ access_token: 'at' }, now), { accessToken: 'at' });
  assert.equal(parseTokenResponse({ refresh_token: 'rt' }, now), null, 'no access token, no result');
  assert.equal(parseTokenResponse(null, now), null);
  assert.equal(parseTokenResponse('nope', now), null);
  assert.equal(parseTokenResponse({ access_token: '' }, now), null);
  // A nonsensical expiry is dropped rather than making the token look dead.
  assert.deepEqual(parseTokenResponse({ access_token: 'at', expires_in: -5 }, now), { accessToken: 'at' });
});

test('an access token is usable until close to its expiry', () => {
  const now = 10_000_000;
  assert.equal(accessTokenUsable({ accessToken: 'at' }, now), true, 'no expiry means use it');
  assert.equal(accessTokenUsable({ accessToken: 'at', expiresAt: now + 120_000 }, now), true);
  // Inside the one-minute skew the token is treated as dead, so it is
  // refreshed before it can fail mid-handshake.
  assert.equal(accessTokenUsable({ accessToken: 'at', expiresAt: now + 30_000 }, now), false);
  assert.equal(accessTokenUsable({ accessToken: 'at', expiresAt: now - 1 }, now), false);
  assert.equal(accessTokenUsable({}, now), false);
});

test('a stored oauth record is clamped, never trusted', () => {
  const cleaned = normaliseMailOAuth({
    clientId: '  cid  ',
    clientSecret: ' secret ',
    authUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scopes: ' mail.read ',
    accessToken: ' at ',
    refreshToken: ' rt ',
    expiresAt: 123.7,
    extraParams: { access_type: 'offline', bad: 42, '': 'x' },
    host: 'javascript:alert(1)',
  });
  assert.ok(cleaned);
  assert.equal(cleaned!.clientId, 'cid');
  assert.equal(cleaned!.clientSecret, 'secret');
  assert.equal(cleaned!.scopes, 'mail.read');
  assert.equal(cleaned!.accessToken, 'at');
  assert.equal(cleaned!.refreshToken, 'rt');
  assert.equal(cleaned!.expiresAt, 124, 'rounded, never fractional');
  assert.deepEqual(cleaned!.extraParams, { access_type: 'offline' }, 'non-string extras are dropped');
  // Unknown fields (a smuggled host, say) never ride along.
  assert.equal('host' in cleaned!, false);
  // A config that cannot drive a sign-in becomes null, not a half-record.
  assert.equal(normaliseMailOAuth({ clientId: 'x', authUrl: 'nope', tokenUrl: 'https://x.test/t' }), null);
  assert.equal(normaliseMailOAuth({ authUrl: 'https://x.test/a', tokenUrl: 'https://x.test/t' }), null);
  assert.equal(normaliseMailOAuth(null), null);
  assert.equal(normaliseMailOAuth('junk'), null);
});

test('tokens and config are detected independently', () => {
  assert.equal(hasOauthTokens({ accessToken: 'at' }), true);
  assert.equal(hasOauthTokens({ refreshToken: 'rt' }), true);
  assert.equal(hasOauthTokens({ accessToken: '', refreshToken: '' }), false);
  assert.equal(hasOauthTokens(undefined), false);
  assert.equal(oauthConfigUsable({ clientId: 'x', authUrl: 'https://a.test', tokenUrl: 'https://b.test' }), true);
  assert.equal(oauthConfigUsable({ clientId: 'x', authUrl: 'nope', tokenUrl: 'https://b.test' }), false);
  assert.equal(oauthConfigUsable({ clientId: '', authUrl: 'https://a.test', tokenUrl: 'https://b.test' }), false);
});

test('the presets are the two providers people actually ask for, plus custom', () => {
  assert.equal(OAUTH_PRESETS.length, 3);
  for (const preset of OAUTH_PRESETS.slice(0, 2)) {
    assert.ok(isHttpUrl(preset.authUrl), `${preset.id} authorize URL`);
    assert.ok(isHttpUrl(preset.tokenUrl), `${preset.id} token URL`);
    assert.ok(preset.scopes.trim(), `${preset.id} carries a scope`);
    assert.ok(preset.hint.trim(), `${preset.id} tells the user what to create`);
  }
  // Google's refresh token needs offline+consent on a desktop client.
  assert.equal(GOOGLE.extraParams?.access_type, 'offline');
  assert.equal(GOOGLE.extraParams?.prompt, 'consent');
  // The Gmail full-mail scope is the one Google accepts for IMAP XOAUTH2.
  assert.equal(GOOGLE.scopes, 'https://mail.google.com/');
  // Custom starts blank — the form is the same, nothing is guessed.
  const custom = oauthPresetById('custom');
  assert.equal(custom.authUrl, '');
  assert.equal(custom.tokenUrl, '');
  // An unknown id falls back to custom rather than silently becoming Google.
  assert.equal(oauthPresetById('nope').id, 'custom');
});

test('http URLs are accepted only as http(s), loopback included', () => {
  assert.equal(isHttpUrl('https://x.test/a'), true);
  assert.equal(isHttpUrl('http://127.0.0.1:9/'), true);
  assert.equal(isHttpUrl('file:///x'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl(null), false);
});

test('a normalised record keeps a MailOAuth shape the mailer accepts', () => {
  const record: MailOAuth = normaliseMailOAuth({
    clientId: 'cid',
    authUrl: GOOGLE.authUrl,
    tokenUrl: GOOGLE.tokenUrl,
    scopes: GOOGLE.scopes,
    extraParams: GOOGLE.extraParams,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  })!;
  assert.ok(record);
  assert.equal(record.clientId, 'cid');
  assert.equal(hasOauthTokens(record), true);
  assert.equal(accessTokenUsable(record, Date.now()), true);
});
