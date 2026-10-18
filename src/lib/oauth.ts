/**
 * Generic OAuth2 for mailboxes.
 *
 * Connecting a mailbox should not require an app password: any provider that
 * speaks OAuth2 (Google, Microsoft, most custom servers) can grant a token
 * through the standard authorization-code flow, and the token then
 * authenticates IMAP over SASL XOAUTH2. The flow itself is provider-agnostic
 * — only three URLs and a scope differ — so this module holds the pieces both
 * sides share: the account's stored shape, the presets that prefill it, and
 * the pure helpers (URL building, token parsing, expiry) that the main
 * process's loopback dance and the tests both read.
 *
 * No HTTP happens here. The renderer never sees a client secret exchange;
 * that lives in electron/oauth.ts, and these helpers only build and parse
 * the plain data both processes agree on.
 */

/** How one mailbox signs in. App password is the default; OAuth replaces it. */
export type MailAuthKind = 'app-password' | 'oauth';

/**
 * One mailbox's OAuth2 configuration and tokens, stored on the account.
 *
 * The config fields (clientId … extraParams) are the user's own — pasted
 * from their provider's developer console — and never change once sign-in
 * works. The token fields are what the sign-in produced; they refresh in the
 * main process, so a stale access token in prefs is normal and harmless as
 * long as the refresh token survives.
 */
export interface MailOAuth {
  /** The OAuth client id the user created at their provider. */
  clientId: string;
  /** Optional. Public clients (desktop apps) usually have none. */
  clientSecret?: string;
  /** Where the browser is sent to authorize. */
  authUrl: string;
  /** Where codes and refresh tokens are exchanged. */
  tokenUrl: string;
  /** Space-separated OAuth scopes. Must include the provider's IMAP scope. */
  scopes: string;
  /**
   * Fixed extra query parameters some providers demand, e.g. Google's
   * `access_type=offline`. Preset-supplied, not user-edited.
   */
  extraParams?: Record<string, string>;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when `accessToken` expires. Absent means "no expiry known". */
  expiresAt?: number;
}

/** One prefilled provider in the sign-in form. */
export interface OAuthPreset {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  extraParams?: Record<string, string>;
  /** Where the user creates a client id — opened from the form. */
  consoleUrl: string;
  /** One line under the fields: what to create, and of what type. */
  hint: string;
}

/**
 * The presets offered in the Inbox section.
 *
 * "Custom" starts blank: the form is the same three URLs and a scope, so any
 * provider that speaks standard OAuth2 can be wired up by hand.
 */
export const OAUTH_PRESETS: OAuthPreset[] = [
  {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // The full-mail scope: it is the one Google accepts for IMAP XOAUTH2.
    scopes: 'https://mail.google.com/',
    // offline+consent is the only combination Google reliably answers with a
    // refresh token for a desktop client.
    extraParams: { access_type: 'offline', prompt: 'consent' },
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    hint: 'In Google Cloud: enable the Gmail API, create an OAuth client ID of type “Desktop app”, and paste its client ID below.',
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    // Microsoft's v2 endpoint defaults to form_post for some client types;
    // query keeps the redirect a plain GET the loopback server can answer.
    extraParams: { response_mode: 'query' },
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    hint: 'In the Azure portal: register an app, add a desktop redirect URI of http://127.0.0.1 (any port), grant IMAP.AccessAsUser.All, and paste the Application (client) ID.',
  },
  {
    id: 'custom',
    label: 'Custom OAuth2',
    authUrl: '',
    tokenUrl: '',
    scopes: '',
    consoleUrl: '',
    hint: 'Paste the provider’s authorize URL, token URL and the IMAP scope. The app adds the standard code flow with PKCE.',
  },
];

export function oauthPresetById(id: string): OAuthPreset {
  return OAUTH_PRESETS.find((preset) => preset.id === id) ?? OAUTH_PRESETS[OAUTH_PRESETS.length - 1]!;
}

/** True for an absolute http(s) URL. Loopback OAuth is http; everything else should be https. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A stored oauth record whose config could drive a sign-in (tokens optional). */
export function oauthConfigUsable(value: unknown): value is MailOAuth {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.clientId === 'string' &&
    record.clientId.trim() !== '' &&
    isHttpUrl(record.authUrl) &&
    isHttpUrl(record.tokenUrl)
  );
}

/** True when a stored oauth record carries any token at all — enough to attempt a read. */
export function hasOauthTokens(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.accessToken === 'string' && record.accessToken !== '') ||
    (typeof record.refreshToken === 'string' && record.refreshToken !== '')
  );
}

/**
 * Builds the browser authorization URL, or '' when the config cannot produce
 * a safe one.
 *
 * PKCE (S256) and a random state ride along on every flow: the state is
 * checked on the way back, and the code verifier never leaves the app, so a
 * stolen authorization code cannot be redeemed without the app itself.
 */
export function buildAuthorizeUrl(
  config: Pick<MailOAuth, 'clientId' | 'authUrl' | 'scopes' | 'extraParams'>,
  flow: { redirectUri: string; state: string; codeChallenge: string },
): string {
  if (!config.clientId.trim() || !isHttpUrl(config.authUrl) || !isHttpUrl(flow.redirectUri)) return '';
  let url: URL;
  try {
    url = new URL(config.authUrl.trim());
  } catch {
    return '';
  }
  url.searchParams.set('client_id', config.clientId.trim());
  url.searchParams.set('redirect_uri', flow.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', flow.state);
  url.searchParams.set('code_challenge', flow.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.scopes.trim()) url.searchParams.set('scope', config.scopes.trim());
  for (const [key, value] of Object.entries(config.extraParams ?? {})) {
    if (key && typeof value === 'string') url.searchParams.set(key, value);
  }
  return url.toString();
}

/** What a token endpoint's JSON answer means to this app. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms of expiry, when the endpoint said so. */
  expiresAt?: number;
}

/**
 * Parses a token endpoint's JSON answer, or null when it carries no usable
 * access token. Unreadable fields are dropped one by one rather than failing
 * the whole exchange — a provider that omits expiry still works.
 */
export function parseTokenResponse(json: unknown, now: number): OAuthTokens | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || !record.access_token) return null;
  const tokens: OAuthTokens = { accessToken: record.access_token };
  if (typeof record.refresh_token === 'string' && record.refresh_token) tokens.refreshToken = record.refresh_token;
  if (typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) && record.expires_in > 0) {
    tokens.expiresAt = now + Math.round(record.expires_in * 1000);
  }
  return tokens;
}

/**
 * Whether an access token can still be used as-is.
 *
 * The one-minute skew matters: a token that expires mid-handshake fails as a
 * confusing IMAP auth error, so anything expiring within the next minute is
 * treated as already dead and refreshed first.
 */
export function accessTokenUsable(oauth: Pick<MailOAuth, 'accessToken' | 'expiresAt'>, now: number): boolean {
  if (!oauth.accessToken) return false;
  if (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt)) return true;
  return now < oauth.expiresAt - 60_000;
}

/** What a sign-in answer looks like over IPC. */
export type OAuthConnectResult =
  | ({ ok: true } & OAuthTokens)
  | { ok: false; error: string };

/** What the sign-in form sends: the user's own client config, nothing stored yet. */
export interface OAuthConnectInput {
  clientId: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  extraParams?: Record<string, string>;
}

/**
 * Sanitizes a stored (or hand-edited) oauth record into the app's shape.
 * Returns null when the config cannot drive a sign-in, so a corrupt record
 * degrades to "needs reconnecting" instead of poisoning every read.
 */
export function normaliseMailOAuth(value: unknown): MailOAuth | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const str = (field: string, max: number): string =>
    typeof record[field] === 'string' ? (record[field] as string).trim().slice(0, max) : '';
  const clientId = str('clientId', 200);
  const authUrl = str('authUrl', 400);
  const tokenUrl = str('tokenUrl', 400);
  if (!clientId || !isHttpUrl(authUrl) || !isHttpUrl(tokenUrl)) return null;
  const oauth: MailOAuth = { clientId, authUrl, tokenUrl, scopes: str('scopes', 400) };
  const clientSecret = str('clientSecret', 400);
  if (clientSecret) oauth.clientSecret = clientSecret;
  const accessToken = str('accessToken', 8000);
  if (accessToken) oauth.accessToken = accessToken;
  const refreshToken = str('refreshToken', 2000);
  if (refreshToken) oauth.refreshToken = refreshToken;
  if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && record.expiresAt > 0) {
    oauth.expiresAt = Math.round(record.expiresAt);
  }
  if (record.extraParams && typeof record.extraParams === 'object' && !Array.isArray(record.extraParams)) {
    const extra: Record<string, string> = {};
    for (const [key, val] of Object.entries(record.extraParams as Record<string, unknown>)) {
      if (key && typeof val === 'string') extra[key.trim().slice(0, 60)] = val.slice(0, 300);
    }
    if (Object.keys(extra).length > 0) oauth.extraParams = extra;
  }
  return oauth;
}
