/**
 * Per-login message expander for the login cards.
 *
 * A labelled row under the credentials: closed it reads "Messages", open it
 * lists them newest-first. Fetching happens on expand, not on render — mounting
 * one poller per card would multiply inbox traffic by the visible card count,
 * and most expanders are never opened.
 *
 * Google's feed only returns the ~20 most recent unread messages per read and
 * offers no pagination, so a list fed by reads alone could never grow past
 * that. Every successful read therefore merges into a persistent per-account
 * cache (see `mailCache`), and the list renders from reads + cache together.
 * Every loaded message renders — no paging, no "Load more": the list simply
 * scrolls as far back as the cache reaches.
 *
 * Matching is by the login's username against the sender address, plus the
 * mailbox-owner rule (a login whose username IS a connected mailbox address
 * reads that mailbox). 'auto' shows owner mail, else only matched mail — it
 * never falls back to unrelated recent mail, because that fallback is what
 * made every login show the same list and read as "messages on all logins".
 * Choose 'recent' explicitly per login to see everything recent. An account
 * scope narrower than 'all' (set per channel) limits which accounts are read
 * at all.
 *
 * Who gets the expander at all is `loginShowsMail`'s decision: the login linked
 * to a connected mailbox, plus any login switched on by hand in its editor.
 */

import { useEffect, useRef, useState } from 'react';
import {
  credHash,
  gmailOpenUrl,
  hasMailCreds,
  imapUidOf,
  listGmailOnce,
  mailTargetOf,
  normAppPassword,
  normMailAddress,
  type GmailMessage,
} from './useGmail.ts';
import { gmailHexOf } from '../lib/mail-text.ts';
import { FullMail } from './FullMail.tsx';
import { useFullBody } from './useFullBody.ts';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import type { VaultItem } from '../vault/types.ts';
import { relativeTime } from '../vault/types.ts';
import { mailboxOwnedBy, maskEmail, matchesLogin } from '../vault/site-intel.ts';
import { MailIcon } from './icons.tsx';



export function LoginMessages({
  item,
  accounts,
  accountScope,
  cache,
  maskEmails,
  onCacheMessages,
  onOpenExternal,
  defaultOpen,
}: {
  item: VaultItem;
  accounts: GmailAccount[];
  /** 'all' or one account id, from the active channel's mail settings. */
  accountScope: string;
  /** Previously fetched messages, per account id. Fills the gaps the feed cannot. */
  cache?: Record<string, CachedMailMessage[]>;
  /** Show the first letters of sender addresses only. */
  maskEmails?: boolean;
  /** Persists one account's fresh read into that cache. */
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  /** Opens a message link in the real browser (never a second app window). */
  onOpenExternal?: (url: string) => void;
  /** Starts expanded with a read underway. Used when the expander lives in its own window. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<GmailMessage[] | null>(null);
  /** What the last read returned per account — shown when the box is empty so "0" says which mailbox said it. */
  const [counts, setCounts] = useState<{ address: string; count: number }[]>([]);
  /** The one message showing its full details, by account:id. Null collapses all. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { bodies: fullBodies, load: loadFullBody, available: canFullBody } = useFullBody();
  // Full bodies fetch once per opened message, keyed by account:id. The set
  // survives re-renders so opening, closing and reopening never refetches.
  const requested = useRef<Set<string>>(new Set());
  // What the last read actually read: scope, matching inputs and credentials.
  // App passwords are usually *fixed* between visits, so an expander that
  // read empty must re-read when they change — otherwise corrected
  // credentials keep showing a stale "No messages found." forever.
  const scopeKey = JSON.stringify([
    accountScope,
    item.username,
    item.mailFilter ?? 'auto',
    accounts
      .filter((account) => account.enabled && hasMailCreds(account))
      .map((account) => `${account.id}|${normMailAddress(account.address).toLowerCase()}|${credHash(normAppPassword(account.appPassword))}`)
      .sort(),
  ]);
  const lastLoadKey = useRef<string | null>(null);

  useEffect(() => {
    if (defaultOpen && messages === null) void load();
    // Runs once per mount by design: it kicks off the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen]);

  async function load() {
    lastLoadKey.current = scopeKey;
    setLoading(true);
    setError(null);
    requested.current.clear();
    setExpandedId(null);
    try {
      // Which mailboxes this login may read at all. Normally the channel's
      // scope decides — but a login whose own address IS a connected mailbox
      // reads exactly that one, whatever the channel says. That is the
      // "linked to an email" case: one login, its own mailbox, never every
      // other login's mail as well.
      const ownedLive = mailboxOwnedBy(item.username, accounts.filter((account) => account.enabled && hasMailCreds(account)));
      const scopeFilter = (account: GmailAccount) =>
        ownedLive
          ? account.id === ownedLive.id
          : accountScope === 'all' || account.id === accountScope;
      const live = accounts.filter(
        (account) => account.enabled && hasMailCreds(account) && scopeFilter(account),
      );
      if (live.length === 0) {
        // Same empty box as "no mail", but a different problem: say which.
        setMessages([]);
        setCounts([]);
        setError(
          accountScope === 'all'
            ? 'No connected mailbox has an address and an app password yet. Add one in the login editor.'
            : 'This channel reads one mailbox that is not connected. Pick it in the channel editor or switch the channel back to all mailboxes.',
        );
        return;
      }
      const perAccount = await Promise.all(
        live.map(async (account) => {
          const { messages: found, error: failed } = await listGmailOnce(
            account.address,
            account.appPassword,
            account.id,
            mailTargetOf(account),
          );
          return { account, found, failed };
        }),
      );
      const failures = perAccount.filter((entry) => entry.failed);
      setCounts(perAccount.map((entry) => ({ address: entry.account.address, count: entry.found.length })));
      if (failures.length > 0 && perAccount.every((entry) => entry.found.length === 0)) {
        // Total failure: clear to an empty list alongside the error, so a
        // previous login's messages are never left on screen as if they
        // belonged here, and reopening reliably retries.
        setMessages([]);
        setError(failures.map((entry) => entry.failed).join(' '));
        return;
      }
      // Reads that came back fine join the persistent cache, so the next
      // expand starts further back than any single read could reach.
      for (const entry of perAccount) {
        if (entry.found.length > 0) onCacheMessages?.(entry.account.id, entry.found);
      }
      // Fresh reads plus everything cached before, newest first, deduped.
      // Without the cache half this list could never pass ~20: that is all
      // Google hands over per read.
      const seen = new Set<string>();
      const all: GmailMessage[] = [];
      for (const message of [...perAccount.flatMap((entry) => entry.found), ...cachedInScope()]) {
        const key = `${message.accountId}:${message.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(message);
      }
      all.sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''));
      // A mailbox owner reads their own mailbox, newest first — matching
      // senders against your own address is what hid everything before. `live`
      // is already narrowed to that one mailbox above, so this is the whole
      // list rather than a filter, but the guard keeps it explicit.
      if (ownedLive) {
        setMessages(all.filter((message) => message.accountId === ownedLive.id));
        return;
      }
      const matched = all.filter((message) => matchesLogin(message, item.username));
      const mode = item.mailFilter ?? 'auto';
      if (mode === 'recent') {
        // Everything recent, skipping the matching entirely. Explicit opt-in
        // per login: the only mode that ever shows unrelated mail.
        setMessages(all);
      } else if (matched.length > 0) {
        setMessages(matched);
      } else {
        // Nothing matched this login: show the mailboxes' recent mail rather
        // than an empty box. The Messages button is the way *into* the mail, so
        // an empty result is only honest when there is no mail at all; a login
        // that wants only its own matched mail sets the filter to 'Matched
        // only' in its editor.
        setMessages(all);
      }
    } finally {
      setLoading(false);
    }
  }

  /** Cached messages for the accounts currently in scope, newest first. */
  function cachedInScope(): GmailMessage[] {
    if (!cache) return [];
    // Same narrowing the live read uses: a login that owns a mailbox only ever
    // sees that mailbox's history, never the other accounts' cached mail.
    const owned = mailboxOwnedBy(
      item.username,
      accounts.filter((account) => account.enabled && hasMailCreds(account)),
    );
    const out: GmailMessage[] = [];
    for (const account of accounts) {
      if (!account.enabled || !hasMailCreds(account)) continue;
      if (owned ? account.id !== owned.id : accountScope !== 'all' && account.id !== accountScope) continue;
      for (const message of cache[account.id] ?? []) out.push({ ...message, accountId: account.id });
    }
    return out;
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loading) return;
    // A loaded list stays put so reopening never yanks what you were
    // browsing — but an empty box, a failed read, or changed accounts behind
    // it all re-read on open. That is the whole point of opening it again.
    if (messages === null || lastLoadKey.current !== scopeKey || messages.length === 0 || error) {
      void load();
    }
  }

  // The whole point of opening a row is reading the message: the full text
  // starts loading the moment it expands, with no extra button. One IMAP read
  // per message, only for rows the user actually opens.
  useEffect(() => {
    if (!expandedId || !canFullBody || !messages) return;
    if (requested.current.has(expandedId)) return;
    const message = messages.find((entry) => `${entry.accountId}:${entry.id}` === expandedId);
    if (!message || (!gmailHexOf(message.id) && !imapUidOf(message.id))) return;
    const account = accounts.find((entry) => entry.id === message.accountId);
    if (!account) return;
    requested.current.add(expandedId);
    loadFullBody(expandedId, mailTargetOf(account), message.id, message.title, message.author || message.email);
  });

  const accountName = (id: string) => accounts.find((entry) => entry.id === id)?.address ?? '';
  /**
   * The mailbox this login owns, if its own address is a connected one. Says so
   * in the toolbar, so "messages are per login" is visible rather than implied:
   * the expander names the one mailbox it reads.
   */
  const ownerAddress = mailboxOwnedBy(item.username, accounts)?.address ?? '';

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
          {open && messages !== null ? (
            <div className="login-messages__toolbar">
              <span className="field__note" style={{ margin: 0 }}>
                {ownerAddress ? `This login's own mailbox (${ownerAddress}). ` : ''}
                {messages.length === 0
                  ? 'No messages.'
                  : `Showing all ${messages.length} — newest first. Opening a row loads its full text straight away.`}
              </span>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                disabled={loading}
                onClick={(event) => {
                  event.stopPropagation();
                  void load();
                }}
              >
                {loading ? <span className="spinner" /> : null}
                Refresh
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="sec__error">
              {error}{' '}
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => void load()}>
                Retry
              </button>
            </p>
          ) : messages !== null && messages.length === 0 && !loading ? (
            <p className="field__hint">
              {ownerAddress
                ? `No messages in ${ownerAddress} yet.`
                : 'No messages in the connected mailboxes yet.'}
              {counts.length > 0
                ? ` (${counts.map((entry) => `${entry.address || 'a mailbox'}: ${entry.count}`).join(' · ')})`
                : ''}
            </p>
          ) : (
            <>
              <ul className="inbox__list login-messages__list msg-list">
                {(messages ?? []).map((message) => {
                  const key = `${message.accountId}:${message.id}`;
                  const isOpen = expandedId === key;
                  const stamp = Date.parse(message.issued || '');
                  const when = Number.isNaN(stamp) ? '' : new Date(stamp).toLocaleString();
                  const ago = message.issued && relativeTime(Date.parse(message.issued))
                    ? relativeTime(Date.parse(message.issued))
                    : '';
                  return (
                    <li key={key} className="inbox__message" data-open={isOpen || undefined}>
                      {/* Only this header toggles. The detail below is a plain
                          div with no toggle handler, so selecting text inside
                          it can never collapse the row. */}
                      <button
                        type="button"
                        className="msg__head"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? `Collapse: ${message.title || '(no subject)'}` : `Expand: ${message.title || '(no subject)'}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedId(isOpen ? null : key);
                        }}
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
                          className="msg__chev"
                          data-open={isOpen || undefined}
                        >
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                        <span className="msg__head-text">
                          <span className="inbox__subject">{message.title || '(no subject)'}</span>
                          <span
                            className="inbox__meta"
                            title={[message.author, message.email].filter(Boolean).join(' · ') || undefined}
                          >
                            {(maskEmails
                              ? maskEmail(message.author || message.email)
                              : message.author || message.email) || 'Unknown sender'}
                            {accountName(message.accountId) ? ` · ${accountName(message.accountId)}` : ''}
                            {ago ? ` · ${ago}` : ''}
                          </span>
                        </span>
                      </button>
                      {message.summary && !isOpen ? <span className="inbox__summary">{message.summary}</span> : null}
                      {isOpen ? (
                        <div className="login-messages__detail" onClick={(event) => event.stopPropagation()}>
                          <dl className="msg__fields">
                            <div className="msg__field">
                              <dt>From</dt>
                              <dd title={[message.author, message.email].filter(Boolean).join(' · ') || undefined}>
                                {(maskEmails
                                  ? [maskEmail(message.author), maskEmail(message.email)].filter(Boolean).join(' · ')
                                  : [message.author, message.email].filter(Boolean).join(' · ')) || 'Unknown sender'}
                              </dd>
                            </div>
                            <div className="msg__field">
                              <dt>Date</dt>
                              <dd>{when || 'Unknown date'}{ago ? ` (${ago})` : ''}</dd>
                            </div>
                            {accountName(message.accountId) ? (
                              <div className="msg__field">
                                <dt>Mailbox</dt>
                                <dd>{accountName(message.accountId)}</dd>
                              </div>
                            ) : null}
                            <div className="msg__field">
                              <dt>Subject</dt>
                              <dd>{message.title || '(no subject)'}</dd>
                            </div>
                          </dl>
                          {message.summary ? (
                            <p className="inbox__summary inbox__summary--full">{message.summary}</p>
                          ) : (
                            <span className="field__hint">No preview text.</span>
                          )}
                          <span className="login-messages__actions">
                            {onOpenExternal ? (
                              <button
                                type="button"
                                className="btn btn--quiet btn--sm"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const account = accounts.find((entry) => entry.id === message.accountId);
                                  onOpenExternal(gmailOpenUrl(message, account?.address ?? ''));
                                }}
                              >
                                Open in Gmail
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn--quiet btn--sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedId(null);
                              }}
                            >
                              Collapse
                            </button>
                          </span>
                          {canFullBody && (gmailHexOf(message.id) || imapUidOf(message.id)) ? (
                            fullBodies[key]?.status === 'ok' ? (
                              <FullMail
                                html={fullBodies[key]?.html}
                                text={fullBodies[key]?.text}
                                images={fullBodies[key]?.images}
                                onOpenExternal={onOpenExternal}
                              />
                            ) : fullBodies[key]?.status === 'error' ? (
                              <span className="field__hint">
                                {fullBodies[key]?.error}{' '}
                                <button
                                  type="button"
                                  className="btn btn--quiet btn--sm"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    const account = accounts.find((entry) => entry.id === message.accountId);
                                    if (account) {
                                      requested.current.delete(key);
                                      loadFullBody(key, mailTargetOf(account), message.id, message.title, message.author || message.email);
                                    }
                                  }}
                                >
                                  Retry
                                </button>
                              </span>
                            ) : (
                              <span className="field__hint">
                                <span className="spinner" /> Loading full message…
                              </span>
                            )
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
