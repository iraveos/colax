/**
 * The OAuth2 dance, in the main process.
 *
 * A sign-in is four steps: spin a loopback server on 127.0.0.1, send the
 * browser to the provider's authorize URL, catch the redirect that carries
 * the code, and exchange it at the token endpoint. The renderer never sees
 * the exchange — client secrets and codes stay here — and the tokens that
 * come back travel back once, to be stored on the account like any other
 * credential.
 *
 * Refreshing happens here too: the renderer passes the account's stored
 * oauth record with every mail request, and `resolveAccessToken` hands back
 * a live token, using the refresh token when the access one has expired.
 * Fresh tokens are cached in memory keyed by refresh token, so one expired
 * token does not become a network round trip per poll.
 *
 * Everything the provider could fake arrives through the browser redirect:
 * the state is checked, the code is redeemed with the PKCE verifier that
 * never left this process, and only the loopback port answers. There is no
 * custom protocol, no deep link, nothing a second app could squat on.
 */

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessTokenUsable,
  buildAuthorizeUrl,
  parseTokenResponse,
  type MailOAuth,
  type OAuthConnectInput,
  type OAuthConnectResult,
  type OAuthTokens,
} from '../src/lib/oauth.ts';

export type { MailOAuth, OAuthConnectInput, OAuthConnectResult, OAuthTokens };

/** How long the browser has to come back with a code. Generous: people read consent screens. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** Refreshed tokens, keyed by client id + refresh token, for this app run. */
const refreshed = new Map<string, OAuthTokens>();

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** One-line cause text for error answers — never a stack. */
function causeText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'unexpected error';
}

/**
 * Starts a loopback server on a random port. Only 127.0.0.1 — never a
 * wildcard bind, so nothing on the network can see the redirect.
 */
async function listenLoopback(): Promise<{ server: Server; redirectUri: string; done: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error('Could not open a local port for the sign-in redirect.');
  }
  const done = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return { server, redirectUri: `http://127.0.0.1:${port}/`, done };
}

/**
 * Waits for the provider to redirect back with a code (or an error).
 * Resolves the code; rejects with the provider's own message when it sent one.
 */
function waitForCode(server: Server, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const finish = (error: Error | null, code?: string) => {
      clearTimeout(timer);
      server.removeListener('request', onRequest);
      if (error) reject(error);
      else resolve(code ?? '');
    };
    const timer = setTimeout(() => {
      finish(new Error('The sign-in was not finished in time. Try again.'));
    }, FLOW_TIMEOUT_MS);
    const onRequest = (
      req: { url?: string },
      res: { writeHead(status: number, headers?: Record<string, string>): void; end(body: string): void },
    ) => {
      let params: URLSearchParams;
      try {
        params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request.');
        return;
      }
      const page = (title: string, body: string) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:15px system-ui;margin:3em;max-width:36em"><h1>${title}</h1><p>${body}</p></body>`;
      if (params.get('error')) {
        const description = params.get('error_description') ?? params.get('error') ?? 'The provider refused the sign-in.';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Sign-in refused', 'You can close this tab and return to Colax.'));
        finish(new Error(description));
        return;
      }
      const state = params.get('state') ?? '';
      const code = params.get('code') ?? '';
      if (state !== expectedState || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Unexpected redirect', 'This tab was not opened by Colax. You can close it.'));
        finish(new Error('The sign-in redirect did not match. Try again.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Signed in', 'Return to Colax — this tab can be closed.'));
      finish(null, code);
    };
    server.on('request', onRequest);
  });
}

/** Exchanges an authorization code (or a refresh grant) for tokens. */
async function tokenRequest(
  tokenUrl: string,
  body: Record<string, string>,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const form = new URLSearchParams(body);
  if (clientSecret) form.set('client_secret', clientSecret);
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (cause) {
    throw new Error(`Could not reach the token endpoint (${causeText(cause)}).`);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const tokens = parseTokenResponse(json, Date.now());
  if (!tokens) {
    const record = (json ?? {}) as Record<string, unknown>;
    const detail =
      typeof record.error_description === 'string' && record.error_description
        ? record.error_description
        : typeof record.error === 'string' && record.error
          ? record.error
          : `the token endpoint answered ${response.status}`;
    throw new Error(`The provider did not hand out a token (${detail}).`);
  }
  return tokens;
}

/**
 * Runs the full authorization-code flow: browser out, code back, code
 * redeemed. `open` is the shell's http(s)-guarded browser opener, passed in
 * so this module never talks to Electron directly and stays testable.
 */
export async function connectOAuth(
  input: OAuthConnectInput,
  open: (url: string) => Promise<void>,
): Promise<OAuthConnectResult> {
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim().slice(0, 200) : '';
  const authUrl = typeof input?.authUrl === 'string' ? input.authUrl.trim() : '';
  const tokenUrl = typeof input?.tokenUrl === 'string' ? input.tokenUrl.trim() : '';
  const scopes = typeof input?.scopes === 'string' ? input.scopes.trim().slice(0, 400) : '';
  const clientSecret = typeof input?.clientSecret === 'string' && input.clientSecret.trim() ? input.clientSecret.trim() : undefined;
  if (!clientId || !authUrl || !tokenUrl) {
    return { ok: false, error: 'A client id, an authorize URL and a token URL are needed first.' };
  }
  const extraParams: Record<string, string> = {};
  if (input?.extraParams && typeof input.extraParams === 'object') {
    for (const [key, value] of Object.entries(input.extraParams)) {
      if (key && typeof value === 'string') extraParams[key] = value;
    }
  }
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  let listening: Awaited<ReturnType<typeof listenLoopback>>;
  try {
    listening = await listenLoopback();
  } catch (cause) {
    return { ok: false, error: causeText(cause) };
  }
  const authorize = buildAuthorizeUrl(
    { clientId, authUrl, scopes, extraParams },
    { redirectUri: listening.redirectUri, state, codeChallenge: pkceChallenge(verifier) },
  );
  if (!authorize) {
    await listening.done();
    return { ok: false, error: 'That authorize URL is not a valid http(s) address.' };
  }
  try {
    // The loopback server is already listening, so the redirect cannot race
    // ahead of the browser. A refusal to open the browser is a plain error,
    // not a five-minute wait for a redirect that will never come.
    await open(authorize);
    const code = await waitForCode(listening.server, state);
    const tokens = await tokenRequest(tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: listening.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }, clientSecret);
    return { ok: true, ...tokens };
  } catch (cause) {
    return { ok: false, error: causeText(cause) };
  } finally {
    await listening.done();
  }
}

/**
 * A live access token for one account, refreshing when the stored one has
 * expired. Throws a plain message when the provider will not refresh — the
 * caller turns that into "reconnect this mailbox".
 */
export async function resolveAccessToken(oauth: MailOAuth): Promise<string> {
  const cacheKey = `${oauth.clientId}|${oauth.refreshToken ?? ''}`;
  const current: Pick<MailOAuth, 'accessToken' | 'expiresAt'> = refreshed.get(cacheKey) ?? oauth;
  if (accessTokenUsable(current, Date.now())) return current.accessToken ?? '';
  if (!oauth.refreshToken) {
    if (current.accessToken) return current.accessToken;
    throw new Error('This mailbox needs a fresh sign-in.');
  }
  const tokens = await tokenRequest(oauth.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
  }, oauth.clientSecret);
  // Some providers hand back a rotated refresh token; keep the newest pair.
  const stored: OAuthTokens = { accessToken: tokens.accessToken };
  stored.refreshToken = tokens.refreshToken ?? oauth.refreshToken;
  if (tokens.expiresAt) stored.expiresAt = tokens.expiresAt;
  refreshed.set(cacheKey, stored);
  return stored.accessToken;
}
