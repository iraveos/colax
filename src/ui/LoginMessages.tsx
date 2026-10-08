/**
 * Per-login message expander for the login cards.
 *
 * A labelled row under the credentials: closed it reads "Messages", open it
 * lists the last 5. Fetching happens on expand, not on render — mounting one
 * poller per card would multiply inbox traffic by the visible card count, and
 * most expanders are never opened.
 *
 * Matching is by the login's username against the sender address. When nothing
 * matches, the five most recent messages show instead with a note saying so:
 * an empty expander reads as broken, while an honest "none matched" reads as
 * information. An account scope narrower than 'all' (set per channel) limits
 * which accounts are read at all.
 */

import { useState } from 'react';
import { fetchGmailOnce, type GmailMessage } from './useGmail.ts';
import type { GmailAccount } from '../vault/storage.ts';
import type { VaultItem } from '../vault/types.ts';
import { relativeTime } from '../vault/types.ts';
import { MailIcon } from './icons.tsx';

function matchesLogin(message: GmailMessage, username: string): boolean {
  const needle = username.trim().toLowerCase();
  if (!needle) return false;
  return (
    message.email.toLowerCase() === needle || message.author.toLowerCase().includes(needle)
  );
}

export function LoginMessages({
  item,
  accounts,
  accountScope,
}: {
  item: VaultItem;
  accounts: GmailAccount[];
  /** 'all' or one account id, from the active channel's mail settings. */
  accountScope: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<GmailMessage[] | null>(null);
  const [unmatched, setUnmatched] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const live = accounts.filter(
        (account) =>
          account.enabled &&
          account.address &&
          account.appPassword &&
          (accountScope === 'all' || account.id === accountScope),
      );
      const perAccount = await Promise.all(
        live.map(async (account) => {
          let failed: string | null = null;
          const found = await fetchGmailOnce(
            account.address,
            account.appPassword,
            undefined,
            (message) => {
              failed = message;
            },
            undefined,
            account.id,
          );
          return { found, failed };
        }),
      );
      const failures = perAccount.filter((entry) => entry.failed);
      if (failures.length > 0 && perAccount.every((entry) => entry.found.length === 0)) {
        setError(failures.map((entry) => entry.failed).join(' '));
        return;
      }
      const all = perAccount
        .flatMap((entry) => entry.found)
        .sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''));
      // The whole fetch renders as you scroll — the list is scrollable, not
      // paged, so capping it at five would hide mail the fetch already paid for.
      const matched = all.filter((message) => matchesLogin(message, item.username));
      if (matched.length > 0) {
        setMessages(matched);
        setUnmatched(false);
      } else if (item.username.trim()) {
        // Nothing from this sender: recent mail with a note beats an empty box.
        setMessages(all);
        setUnmatched(true);
      } else {
        // No email on the login, so there is nothing to match against — and
        // falling back to recent mail here is what put every other login's
        // mail on logins with no address at all.
        setMessages([]);
        setUnmatched(false);
      }
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (messages !== null || loading) return;
    void load();
  }

  return (
    <div className="login-messages">
      <button
        type="button"
        className="login-messages__toggle"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          void toggle();
        }}
      >
        <MailIcon width="13" height="13" />
        Messages
        {messages !== null && !loading ? <span className="login-messages__count">{messages.length}</span> : null}
        {loading ? <span className="spinner" /> : null}
      </button>
      {open ? (
        <div className="login-messages__body">
          {error ? (
            <p className="sec__error">
              {error}{' '}
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => void load()}>
                Retry
              </button>
            </p>
          ) : messages !== null && messages.length === 0 && !loading ? (
            <p className="field__hint">
              {item.username.trim()
                ? 'No messages found.'
                : 'Add an email to this login to match its messages.'}
            </p>
          ) : (
            <ul className="inbox__list login-messages__list">
              {unmatched ? (
                <li className="field__hint" aria-hidden="true">
                  None matched this login — recent mail:
                </li>
              ) : null}
              {(messages ?? []).map((message) => (
                <li key={`${message.accountId}:${message.id}`} className="inbox__message">
                  <span className="inbox__subject">{message.title || '(no subject)'}</span>
                  <span className="inbox__meta">
                    {message.author || message.email || 'Unknown sender'}
                    {message.issued && relativeTime(Date.parse(message.issued))
                      ? ` · ${relativeTime(Date.parse(message.issued))}`
                      : ''}
                  </span>
                  {message.summary ? <span className="inbox__summary">{message.summary}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
