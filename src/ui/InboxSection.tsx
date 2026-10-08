/**
 * The inbox section of the login editor.
 *
 * This used to live in Settings as "Integrations", which was the wrong home
 * for it: connecting a mailbox is something you do *for a login*, while
 * creating or editing it, not something you configure globally and then go
 * looking for. The accounts live in prefs (several allowed), but the connect
 * form and the messages live where the login lives.
 *
 * Below the accounts sits the recent-messages expander: everything the feeds
 * returned, newest first, in a scrollable list. The list scrolls internally so
 * subjects of any length never grow the editor; older mail belongs in the mail
 * app, but what was already fetched stays visible while scrolling.
 */

import { useState } from 'react';
import { fetchGmailOnce, useGmail, type GmailMessage } from './useGmail.ts';
import { newGmailAccountId, type GmailAccount } from '../vault/storage.ts';
import { Toggle } from './primitives.tsx';
import { relativeTime } from '../vault/types.ts';

// 0 means manual only (first read + the Refresh button, no timer at all).
// The sub-minute choices are there on request, but Google temporarily blocks
// mailboxes that poll every few seconds — the buttons say so outright.
const REFRESH_CHOICES = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5s', risky: true },
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
  const { messages, error, loading, refresh } = useGmail({ accounts, onCacheMessages });

  const patch = (id: string, next: Partial<GmailAccount>) =>
    onAccountsChange(accounts.map((account) => (account.id === id ? { ...account, ...next } : account)));

  async function test(account: GmailAccount) {
    setTesting(account.id);
    try {
      const found = await fetchGmailOnce(account.address, account.appPassword, undefined, undefined, undefined, account.id);
      if (found.length === 0) onNotify('Connected, but no messages were returned.', 'error');
      else {
        onNotify(`Connected: ${found.length} recent message${found.length === 1 ? '' : 's'}`);
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
    if (accounts.some((account) => account.address.toLowerCase() === address.toLowerCase())) {
      onNotify('That address is already connected.', 'error');
      return;
    }
    onAccountsChange([
      ...accounts,
      { id: newGmailAccountId(), address, appPassword, enabled: true, refreshSeconds: 300 },
    ]);
    setDraftAddress('');
    setDraftPassword('');
  }

  const recent = messages;
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.address ?? '';

  return (
    <div className="inbox">
      {accounts.map((account) => (
        <div className="inbox__account" key={account.id}>
          <div className="field-row">
            <span className="inbox__address">{account.address || '(no address)'}</span>
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
                      ? `Check automatically every ${choice.label} — fast enough that Google may temporarily block this mailbox`
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
                    ? ' Fast checks can get this mailbox temporarily blocked by Google — switch to Off + Refresh now if errors appear.'
                    : ''
                }`
              : 'Automatic checks are off — use Refresh now when you want mail. Safest against temporary Google blocks.'}
          </p>
        </div>
      ))}

      <div className="field">
        <span className="field__label">{accounts.length === 0 ? 'Connect a mailbox' : 'Connect another'}</span>
        <div className="field-row">
          <input
            className="input"
            value={draftAddress}
            onChange={(event) => setDraftAddress(event.target.value)}
            placeholder="you@gmail.com"
            inputMode="email"
            spellCheck={false}
            aria-label="Gmail address"
          />
          <input
            className="input input--mono"
            type="password"
            value={draftPassword}
            onChange={(event) => setDraftPassword(event.target.value)}
            placeholder="App password"
            autoComplete="off"
            spellCheck={false}
            aria-label="App password"
          />
          <button type="button" className="btn btn--secondary" onClick={add}>
            Add
          </button>
        </div>
        <p className="field__note">From Google Account › Security › App passwords. Not your normal password.</p>
      </div>

      <div className="field-row">
        {accounts.some((account) => account.enabled && account.address && account.appPassword) ? (
          <button type="button" className="btn btn--quiet" onClick={() => void refresh()} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            Refresh now
          </button>
        ) : null}
      </div>

      {error ? <p className="sec__error">{error}</p> : null}

      {/* The three states are spelled out instead of rendering nothing.
          Previously a failed fetch, an unconnected mailbox and "no mail yet"
          all looked identical — an absent list — which read as the expander
          being broken. */}
      {!error && !loading && recent.length === 0 && accounts.some((a) => a.enabled && a.address && a.appPassword) ? (
        <p className="field__hint">Connected, but the inbox returned no messages.</p>
      ) : null}
      {accounts.length > 0 && !accounts.some((a) => a.address && a.appPassword) ? (
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
