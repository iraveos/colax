/**
 * The inbox section of the login editor.
 *
 * Mailboxes are shared across the vault (they live in prefs): connecting one
 * here makes it available everywhere, it does not attach it to this login
 * alone. Whether this login shows its Messages expander is the separate
 * per-login toggle above. Per-login matching (by email, or by mailbox owner)
 * decides what the expander lists.
 *
 * Any IMAP host can be connected. The provider is recognised from the address
 * as it is typed, and can be overridden for a work server, a self-hosted
 * machine, or a host whose domain does not give it away. Only the connection
 * details differ between providers — the reading code is the same — which is
 * why this is a catalogue and a host/port pair rather than a per-provider
 * implementation.
 */

import { useState } from 'react';
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
  const { messages, error, loading, refresh } = useGmail({ accounts, onCacheMessages });

  const patch = (id: string, next: Partial<GmailAccount>) =>
    onAccountsChange(accounts.map((account) => (account.id === id ? { ...account, ...next } : account)));

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
        <p className="field__note">
          {providerById(draftProvider || providerForAddress(draftAddress)?.id).hint}
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
        <p className="field__hint">Enter an address and app password above to read mail here.</p>
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
