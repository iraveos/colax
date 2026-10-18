/**
 * The inbox section of the login editor.
 *
 * Mailboxes are shared across the vault (they live in prefs): connecting one
 * here makes it available everywhere, it does not attach it to this login
 * alone. Whether this login shows its Messages expander is the separate
 * per-login toggle above. Per-login matching (by email, or by mailbox owner)
 * decides what the expander lists.
 *
 * Two ways to connect, both landing on the same IMAP reading:
 * an app password, typed here, or an OAuth2 sign-in with the user's own
 * client id — the browser opens at the provider, the redirect lands on a
 * loopback port in the main process, and the tokens that come back read mail
 * over SASL XOAUTH2. The sign-in is generic (authorize URL, token URL,
 * scope) with Google and Microsoft prefilled, so any provider that speaks
 * standard OAuth2 can be wired up.
 *
 * Any IMAP host can be connected. The provider is recognised from the address
 * as it is typed, and can be overridden for a work server, a self-hosted
 * machine, or a host whose domain does not give it away. Only the connection
 * details differ between providers — the reading code is the same — which is
 * why this is a catalogue and a host/port pair rather than a per-provider
 * implementation.
 */

import { useRef, useState } from 'react';
import { hasMailCreds, listGmailOnce, mailTargetOf, useGmail, type GmailMessage } from './useGmail.ts';
import { newGmailAccountId, type GmailAccount } from '../vault/storage.ts';
import { Select, Toggle } from './primitives.tsx';
import { relativeTime } from '../vault/types.ts';
import {
  accountLabel,
  isCustomProvider,
  MAIL_PROVIDERS,
  providerById,
  providerForAddress,
  resolveConnection,
} from '../lib/mail-providers.ts';
import { hasOauthTokens, OAUTH_PRESETS, oauthPresetById, type MailOAuth, type OAuthConnectInput, type OAuthConnectResult } from '../lib/oauth.ts';
import { getPlatform } from '../lib/platform.ts';

// 0 means manual only (first read + the Refresh button, no timer at all).
// The sub-minute choices are there on request, but hosts temporarily block
// mailboxes that poll every few seconds — the labels say so outright.
const REFRESH_CHOICES = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s', risky: true },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
  { value: 900, label: '15m' },
];

export function InboxSection({
  accounts,
  onAccountsChange,
  onNotify,
  onCacheMessages,
}: {
  accounts: GmailAccount[];
  onAccountsChange: (next: GmailAccount[]) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
}) {
  const [testing, setTesting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draftAddress, setDraftAddress] = useState('');
  const [draftPassword, setDraftPassword] = useState('');
  const [draftProvider, setDraftProvider] = useState('');
  const [draftHost, setDraftHost] = useState('');
  // The OAuth half of the add form. The preset fills the three URLs and the
  // fixed extra parameters; the client id (and optional secret) are always
  // the user's own, from their provider's developer console.
  const [authMode, setAuthMode] = useState<'password' | 'oauth'>('password');
  const [draftPreset, setDraftPreset] = useState(OAUTH_PRESETS[0]!.id);
  const [draftClientId, setDraftClientId] = useState('');
  const [draftClientSecret, setDraftClientSecret] = useState('');
  const [draftAuthUrl, setDraftAuthUrl] = useState(OAUTH_PRESETS[0]!.authUrl);
  const [draftTokenUrl, setDraftTokenUrl] = useState(OAUTH_PRESETS[0]!.tokenUrl);
  const [draftScopes, setDraftScopes] = useState(OAUTH_PRESETS[0]!.scopes);
  const [draftExtra, setDraftExtra] = useState<Record<string, string> | undefined>(OAUTH_PRESETS[0]!.extraParams);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  // The last sign-in failure, kept on the account row itself rather than only
  // in a fading toast: a provider refusal ("invalid_client", "access
  // blocked", a cancelled consent) must stay readable next to the button that
  // retries it, or the row just looks stuck at "not signed in yet".
  const [signInFailure, setSignInFailure] = useState<{ id: string; message: string } | null>(null);
  const { messages, error, loading, refresh } = useGmail({ accounts, onCacheMessages });
  const oauthAvailable = typeof getPlatform().oauth?.connect === 'function';
  // Mirrored so the async sign-in flows patch the list that is current when
  // they finish, not the one captured when they started. Without this the
  // token patch after a successful browser flow maps over the pre-add array
  // and silently drops the account it just saved.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const patch = (id: string, next: Partial<GmailAccount>) =>
    onAccountsChange(accountsRef.current.map((account) => (account.id === id ? { ...account, ...next } : account)));

  /** Prefills the URLs and scopes from a preset. Custom starts blank. */
  function applyPreset(id: string) {
    setDraftPreset(id);
    const preset = oauthPresetById(id);
    setDraftAuthUrl(preset.authUrl);
    setDraftTokenUrl(preset.tokenUrl);
    setDraftScopes(preset.scopes);
    setDraftExtra(preset.extraParams);
  }

  /**
   * Runs the sign-in in the real browser and returns the tokens. Shared by
   * the add form and per-account reconnect: the flow is identical, only the
   * address it lands on differs.
   */
  async function signIn(config: OAuthConnectInput): Promise<OAuthConnectResult> {
    const oauth = getPlatform().oauth;
    if (!oauth) {
      return { ok: false, error: 'OAuth sign-in needs the desktop app — a browser page cannot run the local redirect.' };
    }
    return oauth.connect(config);
  }

  /** Reconnects one OAuth account: same client config, fresh tokens. */
  async function reconnect(account: GmailAccount) {
    const config = account.oauth;
    if (!config) return;
    setSigningIn(account.id);
    setSignInFailure(null);
    try {
      const result = await signIn({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authUrl: config.authUrl,
        tokenUrl: config.tokenUrl,
        scopes: config.scopes,
        extraParams: config.extraParams,
      });
      if (!result.ok) {
        setSignInFailure({ id: account.id, message: result.error });
        onNotify(result.error, 'error');
        return;
      }
      patch(account.id, {
        oauth: {
          ...config,
          accessToken: result.accessToken,
          // A rotated refresh token replaces the old one; a provider that
          // sends none keeps the working one.
          refreshToken: result.refreshToken ?? config.refreshToken,
          expiresAt: result.expiresAt,
        },
      });
      setSignInFailure(null);
      onNotify(`Reconnected to ${accountLabel(account)}`);
      void refresh();
    } finally {
      setSigningIn(null);
    }
  }

  /**
   * Typing an address selects its provider, until the user picks one by hand.
   * Recognising the host is what makes "connect any account" a one-field
   * question for the common case.
   */
  const onAddressChange = (value: string) => {
    setDraftAddress(value);
    if (draftProvider && draftProvider !== 'custom') return;
    const guess = providerForAddress(value);
    if (guess && guess.id !== 'custom') setDraftProvider(guess.id);
  };

  async function test(account: GmailAccount) {
    setTesting(account.id);
    try {
      const { messages: found, error: failed } = await listGmailOnce(
        account.address,
        account.appPassword,
        account.id,
        mailTargetOf(account),
      );
      if (failed) onNotify(failed, 'error');
      else if (found.length === 0) onNotify('Connected, but the mailbox returned no messages.', 'error');
      else {
        onNotify(`Connected to ${accountLabel(account)}: ${found.length} recent message${found.length === 1 ? '' : 's'}`);
        void refresh();
      }
    } finally {
      setTesting(null);
    }
  }

  function add() {
    const address = draftAddress.trim();
    const appPassword = draftPassword.replace(/\s+/g, '');
    if (!address || !appPassword) {
      onNotify('Enter an address and an app password first.', 'error');
      return;
    }
    if (accounts.some((account) => account.address.trim().toLowerCase() === address.toLowerCase())) {
      onNotify('That address is already connected.', 'error');
      return;
    }
    const providerId = draftProvider || providerForAddress(address)?.id || 'gmail';
    const preset = providerById(providerId);
    const host = isCustomProvider(providerId) ? draftHost.trim() : '';
    if (isCustomProvider(providerId) && !host) {
      onNotify('A custom server needs its IMAP hostname.', 'error');
      return;
    }
    onAccountsChange([
      ...accounts,
      {
        id: newGmailAccountId(),
        address,
        appPassword,
        enabled: true,
        refreshSeconds: 300,
        provider: providerId,
        host,
        port: preset.port,
        secure: preset.secure,
      },
    ]);
    setDraftAddress('');
    setDraftPassword('');
    setDraftHost('');
    setDraftProvider('');
    onNotify(`${preset.label.split(' / ')[0]} mailbox connected`);
  }

  /**
   * The OAuth half of "Add": the account is saved the moment its client
   * config exists — address, client id, URLs — and the browser sign-in runs
   * afterwards, patching the tokens in when it succeeds. A flow that fails
   * (wrong client id, cancelled consent, provider error) therefore costs a
   * click on Sign in, not a retyping of everything; the saved row offers
   * exactly that button.
   */
  async function connectOauth() {
    const address = draftAddress.trim();
    if (!address) {
      onNotify('Enter the mailbox address first.', 'error');
      return;
    }
    if (accounts.some((account) => account.address.trim().toLowerCase() === address.toLowerCase())) {
      onNotify('That address is already connected.', 'error');
      return;
    }
    const clientId = draftClientId.trim();
    if (!clientId || !draftAuthUrl.trim() || !draftTokenUrl.trim()) {
      onNotify('A client id, an authorize URL and a token URL are needed first.', 'error');
      return;
    }
    const providerId = draftProvider || providerForAddress(address)?.id || 'gmail';
    const preset = providerById(providerId);
    const host = isCustomProvider(providerId) ? draftHost.trim() : '';
    if (isCustomProvider(providerId) && !host) {
      onNotify('A custom server needs its IMAP hostname.', 'error');
      return;
    }
    const oauth: MailOAuth = {
      clientId,
      clientSecret: draftClientSecret.trim() || undefined,
      authUrl: draftAuthUrl.trim(),
      tokenUrl: draftTokenUrl.trim(),
      scopes: draftScopes.trim(),
      extraParams: draftExtra,
    };
    const id = newGmailAccountId();
    onAccountsChange([
      ...accounts,
      {
        id,
        address,
        appPassword: '',
        auth: 'oauth',
        oauth,
        enabled: true,
        refreshSeconds: 300,
        provider: providerId,
        host,
        port: preset.port,
        secure: preset.secure,
      },
    ]);
    setDraftAddress('');
    setDraftClientId('');
    setDraftClientSecret('');
    setDraftHost('');
    setDraftProvider('');
    setSigningIn(id);
    setSignInFailure(null);
    try {
      const result = await signIn({
        clientId,
        clientSecret: oauth.clientSecret,
        authUrl: oauth.authUrl,
        tokenUrl: oauth.tokenUrl,
        scopes: oauth.scopes,
        extraParams: oauth.extraParams,
      });
      if (!result.ok) {
        setSignInFailure({ id, message: result.error });
        onNotify(`${result.error} The mailbox is saved — use its Sign in button to try again.`, 'error');
        return;
      }
      patch(id, {
        oauth: {
          ...oauth,
          accessToken: result.accessToken,
          // A rotated refresh token replaces the old one; a provider that
          // sends none keeps the working one.
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        },
      });
      setSignInFailure(null);
      onNotify(`Signed in — ${preset.label.split(' / ')[0]} mailbox connected`);
      void refresh();
    } finally {
      setSigningIn(null);
    }
  }

  const recent = messages;
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.address ?? '';

  return (
    <div className="inbox">
      {accounts.map((account) => {
        const connection = resolveConnection(account);
        const preset = providerById(account.provider);
        const custom = isCustomProvider(preset.id);
        return (
          <div className="inbox__account" key={account.id}>
            <div className="field-row">
              <span className="inbox__address">{account.address || '(no address)'}</span>
              <span className="chip chip--muted">{accountLabel(account)}</span>
              {account.auth === 'oauth' ? <span className="chip chip--accent">OAuth</span> : null}
              <Toggle
                label={`Enable ${account.address || 'mailbox'}`}
                checked={account.enabled}
                onChange={(enabled) => patch(account.id, { enabled })}
              />
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => onAccountsChange(accounts.filter((entry) => entry.id !== account.id))}
              >
                Remove
              </button>
            </div>
            {account.auth === 'oauth' ? (
              <>
                <div className="field-row">
                  <span className="field__note" style={{ margin: 0 }}>
                    {hasOauthTokens(account.oauth)
                      ? 'Signed in with OAuth — no app password. Tokens refresh on their own; Reconnect only when the provider refuses them.'
                      : 'Saved, but not signed in yet — click Sign in to finish connecting this mailbox.'}
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => void test(account)}
                    disabled={testing !== null || !account.address || !hasOauthTokens(account.oauth)}
                  >
                    {testing === account.id ? <span className="spinner" /> : null}
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => void reconnect(account)}
                    disabled={signingIn !== null}
                  >
                    {signingIn === account.id ? <span className="spinner" /> : null}
                    {hasOauthTokens(account.oauth) ? 'Reconnect' : 'Sign in'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    title="Drop the sign-in and use an app password instead"
                    onClick={() => patch(account.id, { auth: 'app-password', oauth: undefined })}
                  >
                    Use app password
                  </button>
                </div>
                {signInFailure?.id === account.id ? (
                  <p className="sec__error">
                    Sign-in failed: {signInFailure.message} — fix what it names and click Sign in again.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="field-row">
                <input
                  className="input input--mono"
                  type="password"
                  value={account.appPassword}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`App password for ${account.address || 'mailbox'}`}
                  placeholder="App password"
                  onChange={(event) => patch(account.id, { appPassword: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void test(account)}
                  disabled={testing !== null || !account.address || !account.appPassword}
                >
                  {testing === account.id ? <span className="spinner" /> : null}
                  Test
                </button>
              </div>
            )}
            <div className="field-row">
              <Select
                value={preset.id}
                label={`Provider for ${account.address || 'mailbox'}`}
                options={MAIL_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
                onChange={(provider) => {
                  const next = providerById(provider);
                  patch(account.id, {
                    provider,
                    // A preset owns its host, so switching back to one clears a
                    // hand-typed server rather than leaving the two disagreeing.
                    host: isCustomProvider(provider) ? account.host ?? '' : '',
                    port: next.port,
                    secure: next.secure,
                  });
                }}
              />
              <span className="field__note" style={{ margin: 0 }}>
                {connection.host}:{connection.port} {connection.secure ? 'TLS' : 'STARTTLS'}
              </span>
            </div>
            {custom ? (
              <div className="field-row">
                <input
                  className="input input--mono"
                  value={account.host ?? ''}
                  onChange={(event) => patch(account.id, { host: event.target.value })}
                  placeholder="imap.example.com"
                  spellCheck={false}
                  aria-label={`IMAP host for ${account.address || 'mailbox'}`}
                />
                <input
                  className="input input--mono input--port"
                  value={String(account.port ?? preset.port)}
                  onChange={(event) => {
                    const port = Number.parseInt(event.target.value, 10);
                    patch(account.id, {
                      port: Number.isFinite(port) ? port : preset.port,
                      secure: Number.isFinite(port) ? port !== 143 : preset.secure,
                    });
                  }}
                  inputMode="numeric"
                  spellCheck={false}
                  aria-label="IMAP port"
                />
                <Toggle
                  label={`Encrypted connection to ${account.address || 'mailbox'}`}
                  checked={account.secure !== false}
                  onChange={(secure) => patch(account.id, { secure })}
                />
                <span className="field__note" style={{ margin: 0 }}>
                  Encrypted
                </span>
              </div>
            ) : null}
            <div className="segmented segmented--wrap" role="group" aria-label={`Auto-check for ${account.address || 'mailbox'}`}>
              {REFRESH_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className="segmented__option"
                  aria-pressed={(account.refreshSeconds || 0) === choice.value}
                  title={
                    choice.value === 0
                      ? 'No automatic checks — only Refresh now'
                      : 'risky' in choice && choice.risky
                        ? `Check automatically every ${choice.label} — fast enough that the host may temporarily block this mailbox`
                        : `Check automatically every ${choice.label}`
                  }
                  onClick={() => patch(account.id, { refreshSeconds: choice.value })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="field__note">
              {account.refreshSeconds > 0
                ? `Auto-checks every ${REFRESH_CHOICES.find((c) => c.value === account.refreshSeconds)?.label ?? `${account.refreshSeconds}s`}. Refresh now checks immediately.${
                    account.refreshSeconds < 60
                      ? ' Fast checks can get this mailbox temporarily blocked — switch to Off + Refresh now if errors appear.'
                      : ''
                  }`
                : 'Automatic checks are off — use Refresh now when you want mail. Safest against temporary blocks.'}
            </p>
          </div>
        );
      })}

      <div className="field">
        <span className="field__label">{accounts.length === 0 ? 'Connect a mailbox' : 'Connect another'}</span>
        <div className="field-row">
          <input
            className="input"
            value={draftAddress}
            onChange={(event) => onAddressChange(event.target.value)}
            placeholder="you@example.com"
            inputMode="email"
            spellCheck={false}
            aria-label="Mail address"
          />
          <Select
            value={draftProvider || providerForAddress(draftAddress)?.id || 'gmail'}
            label="Mail provider"
            options={MAIL_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
            onChange={setDraftProvider}
          />
        </div>
        {isCustomProvider(draftProvider) ? (
          <div className="field-row">
            <input
              className="input input--mono"
              value={draftHost}
              onChange={(event) => setDraftHost(event.target.value)}
              placeholder="imap.example.com"
              spellCheck={false}
              aria-label="IMAP hostname"
            />
            <span className="field__note" style={{ margin: 0 }}>
              Port 993, TLS — Proton Bridge on this machine uses 127.0.0.1 port 1143 with TLS off.
            </span>
          </div>
        ) : null}
        <div className="segmented segmented--wrap" role="group" aria-label="Sign-in method">
          <button
            type="button"
            className="segmented__option"
            aria-pressed={authMode === 'password'}
            onClick={() => setAuthMode('password')}
          >
            App password
          </button>
          <button
            type="button"
            className="segmented__option"
            aria-pressed={authMode === 'oauth'}
            onClick={() => setAuthMode('oauth')}
          >
            Sign in (OAuth)
          </button>
        </div>
        {authMode === 'password' ? (
          <div className="field-row">
            <input
              className="input input--mono"
              type="password"
              value={draftPassword}
              onChange={(event) => setDraftPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
              placeholder="App password"
              autoComplete="off"
              spellCheck={false}
              aria-label="App password"
            />
            <button type="button" className="btn btn--secondary" onClick={add}>
              Add
            </button>
          </div>
        ) : (
          <>
            <div className="field-row">
              <Select
                value={draftPreset}
                label="OAuth provider"
                options={OAUTH_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
                onChange={applyPreset}
              />
              {oauthPresetById(draftPreset).consoleUrl ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => getPlatform().openExternal(oauthPresetById(draftPreset).consoleUrl)}
                >
                  Where do I get a client id?
                </button>
              ) : null}
            </div>
            <div className="field-row">
              <input
                className="input input--mono"
                value={draftClientId}
                onChange={(event) => setDraftClientId(event.target.value)}
                placeholder="Client ID"
                spellCheck={false}
                aria-label="OAuth client ID"
              />
              <input
                className="input input--mono"
                type="password"
                value={draftClientSecret}
                onChange={(event) => setDraftClientSecret(event.target.value)}
                placeholder="Client secret (optional)"
                autoComplete="off"
                spellCheck={false}
                aria-label="OAuth client secret"
              />
            </div>
            {draftPreset === 'custom' ? (
              <div className="field-row">
                <input
                  className="input input--mono"
                  value={draftAuthUrl}
                  onChange={(event) => setDraftAuthUrl(event.target.value)}
                  placeholder="https://provider.example/authorize"
                  spellCheck={false}
                  aria-label="OAuth authorize URL"
                />
                <input
                  className="input input--mono"
                  value={draftTokenUrl}
                  onChange={(event) => setDraftTokenUrl(event.target.value)}
                  placeholder="https://provider.example/token"
                  spellCheck={false}
                  aria-label="OAuth token URL"
                />
              </div>
            ) : null}
            <div className="field-row">
              <input
                className="input input--mono"
                value={draftScopes}
                onChange={(event) => setDraftScopes(event.target.value)}
                placeholder="OAuth scopes, space-separated"
                spellCheck={false}
                aria-label="OAuth scopes"
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void connectOauth()}
                disabled={signingIn !== null || !oauthAvailable || !draftClientId || !draftAuthUrl || !draftTokenUrl}
              >
                {signingIn !== null ? <span className="spinner" /> : null}
                Sign in with browser
              </button>
            </div>
            <p className="field__note">
              {oauthAvailable
                ? oauthPresetById(draftPreset).hint
                : 'OAuth sign-in needs the desktop app — the browser page cannot run the local redirect. The app-password path still works here.'}
            </p>
          </>
        )}
        <p className="field__note">
          {authMode === 'password' ? providerById(draftProvider || providerForAddress(draftAddress)?.id).hint : null}
        </p>
      </div>

      <div className="field-row">
        {accounts.some((account) => hasMailCreds(account) && account.enabled) ? (
          <button type="button" className="btn btn--quiet" onClick={() => void refresh()} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            Refresh now
          </button>
        ) : null}
      </div>

      {error ? <p className="sec__error">{error}</p> : null}

      {!error && !loading && recent.length === 0 && accounts.some((a) => a.enabled && hasMailCreds(a)) ? (
        <p className="field__hint">Connected, but the mailbox returned no messages.</p>
      ) : null}
      {accounts.length > 0 && !accounts.some((a) => hasMailCreds(a)) ? (
        <p className="field__hint">
          Enter an address and app password — or sign in with OAuth — above to read mail here.
        </p>
      ) : null}

      {recent.length > 0 ? (
        <div className="inbox__recent">
          <button
            type="button"
            className="inbox__expander"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              aria-hidden="true"
              style={{ rotate: expanded ? '90deg' : '0deg' }}
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
            Recent messages ({recent.length})
            <span className="inbox__expander-note">{expanded ? 'Hide' : `Show all ${recent.length}`}</span>
          </button>
          {expanded ? (
            <ul className="inbox__list">
              {recent.map((message: GmailMessage) => (
                <li key={`${message.accountId}:${message.id}`} className="inbox__message">
                  <span className="inbox__subject">{message.title || '(no subject)'}</span>
                  <span className="inbox__meta">
                    {message.author || message.email || 'Unknown sender'}
                    {accountName(message.accountId) ? ` · ${accountName(message.accountId)}` : ''}
                    {message.issued && relativeTime(Date.parse(message.issued))
                      ? ` · ${relativeTime(Date.parse(message.issued))}`
                      : ''}
                  </span>
                  {message.summary ? <span className="inbox__summary">{message.summary}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
