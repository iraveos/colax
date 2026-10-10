/**
 * One mailbox's messages: search, paging, and full-text reading.
 *
 * This replaced a component that could only ever show what a single read
 * returned. Google's Atom feed capped that at about twenty rows and nothing in
 * the app could reach further back, so "your mailbox" really meant "your last
 * twenty messages". Here the list is a window onto the whole mailbox:
 *
 *  - the first page is the newest messages;
 *  - `Load older` asks the server for the page *before* the oldest UID already
 *    held, so the list grows without limit as far back as the user scrolls;
 *  - the search box runs a real server-side search (subject, sender, recipient
 *    and body), so it finds mail that was never fetched, not just what happens
 *    to be on screen.
 *
 * Rows are still envelopes only: a body is read when a row is opened, one
 * message at a time. That is what keeps a fifty-row page cheap over a slow
 * connection.
 *
 * Works against any IMAP host: the account carries its own server, so a Yahoo,
 * Outlook, iCloud or work mailbox is read from the same code path as Gmail.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlatform } from '../lib/platform.ts';
import { accountLabel } from '../lib/mail-providers.ts';
import { gmailHexOf, imapUidOf } from '../lib/mail-text.ts';
import { maskEmail } from '../vault/site-intel.ts';
import { relativeTime } from '../vault/types.ts';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import { FullMail } from './FullMail.tsx';
import { useFullBody } from './useFullBody.ts';
import { gmailOpenUrl, hasMailCreds, listGmailPage, mailTargetOf, type GmailMessage } from './useGmail.ts';
import { Alert, Select } from './primitives.tsx';
import { MailIcon, SearchIcon } from './icons.tsx';

/** Messages per page. One round trip either way; the ceiling is only IPC size. */
const PAGE_SIZE = 50;

export function MailMessages({
  account,
  cache,
  maskEmails,
  onCacheMessages,
  onOpenExternal,
  /** Rendered above the list, for the mail centre's tab strip. */
  header,
}: {
  account: GmailAccount;
  cache?: Record<string, CachedMailMessage[]>;
  maskEmails?: boolean;
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  onOpenExternal: (url: string) => void;
  header?: React.ReactNode;
}) {
  const [rows, setRows] = useState<GmailMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  /** The query the rows on screen belong to — the input is a draft until Enter. */
  const [applied, setApplied] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { bodies: fullBodies, load: loadFullBody, available: canFullBody } = useFullBody();
  const requested = useRef<Set<string>>(new Set());

  const desktopMail = typeof getPlatform().mail?.listInbox === 'function';
  const usable = hasMailCreds(account) && account.enabled;

  /** Replaces the list with the newest page (or the newest matching page). */
  const loadFirst = useCallback(
    async (search: string) => {
      if (!usable) return;
      setLoading(true);
      setError(null);
      setExpandedId(null);
      requested.current.clear();
      try {
        const page = await listGmailPage(mailTargetOf(account), account.id, {
          limit: PAGE_SIZE,
          query: search || undefined,
        });
        if (page.error) {
          setError(page.error);
          setRows([]);
          setHasMore(false);
          return;
        }
        setRows(page.messages);
        setHasMore(page.hasMore);
        if (page.messages.length > 0) onCacheMessages?.(account.id, page.messages);
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    },
    // `account` is a stored record whose identity changes on every prefs write,
    // so the key that actually matters is which mailbox and which password.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account.id, account.address, account.appPassword, usable],
  );

  /** The page after the oldest message held. */
  const loadOlder = useCallback(async () => {
    if (!usable || loadingOlder || rows.length === 0) return;
    // Every IMAP row's id is `imap:<uid>`; the smallest one is the oldest held.
    const uids = rows.map((row) => imapUidOf(row.id)).filter((uid): uid is number => uid !== null);
    const oldest = uids.length > 0 ? Math.min(...uids) : null;
    // Search results are not a contiguous run of UIDs, so paging them would
    // silently skip matches. Older-paging is offered for plain listings, and a
    // search instead asks the server again with the new term.
    if (oldest === null || applied) return;
    setLoadingOlder(true);
    try {
      const page = await listGmailPage(mailTargetOf(account), account.id, {
        limit: PAGE_SIZE,
        beforeUid: oldest,
      });
      if (page.error) {
        setError(page.error);
        return;
      }
      setRows((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...page.messages.filter((row) => !seen.has(row.id))];
      });
      setHasMore(page.hasMore);
      if (page.messages.length > 0) onCacheMessages?.(account.id, page.messages);
    } finally {
      setLoadingOlder(false);
    }
  }, [account, usable, loadingOlder, rows, applied, onCacheMessages]);

  // One read on open, and a fresh one whenever the mailbox itself changes.
  useEffect(() => {
    setQuery('');
    setApplied('');
    setLoaded(false);
    void loadFirst('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.address, account.appPassword, account.host, account.port, account.secure, usable]);

  // Bodies load when a row opens, never for rows nobody looked at.
  useEffect(() => {
    if (!expandedId || !canFullBody) return;
    if (requested.current.has(expandedId)) return;
    const message = rows.find((entry) => `${entry.accountId}:${entry.id}` === expandedId);
    if (!message || (!gmailHexOf(message.id) && !imapUidOf(message.id))) return;
    requested.current.add(expandedId);
    loadFullBody(expandedId, mailTargetOf(account), message.id, message.title, message.author || message.email);
  }, [expandedId, rows, canFullBody, account, loadFullBody]);

  /** Cached history from other screens: shown past this page's end, deduped. */
  const cachedOlder = (cache?.[account.id] ?? []).filter((entry) => !rows.some((live) => live.id === entry.id));
  const shownFrom = (author: string, email: string) => {
    const full = [author, email].filter(Boolean).join(' · ');
    if (!maskEmails) return { text: full, title: full };
    return { text: [maskEmail(author), maskEmail(email)].filter(Boolean).join(' · '), title: full };
  };

  if (!desktopMail) {
    return (
      <Alert tone="info">
        Reading a mailbox needs the desktop app, which connects over IMAP. A web page cannot open a mail
        socket, so there is no way for the browser build to do this. Everything else in the vault is
        unaffected.
      </Alert>
    );
  }

  if (!usable) {
    return (
      <Alert tone="info">
        This mailbox has no address and app password yet, or it is switched off. Add both in a login’s
        editor under Inbox, then come back.
      </Alert>
    );
  }

  const search = (next: string) => {
    setApplied(next);
    void loadFirst(next);
  };

  return (
    <div className="mailbox">
      {header}
      <div className="mailbox__tools">
        <label className="mailbox__search">
          <SearchIcon width="15" height="15" />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search(query.trim());
              if (event.key === 'Escape' && query) {
                setQuery('');
                search('');
              }
            }}
            placeholder={`Search ${account.address || 'this mailbox'} — subject, sender or body`}
            aria-label="Search this mailbox"
            spellCheck={false}
          />
        </label>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => search(query.trim())} disabled={loading}>
          {loading ? <span className="spinner" /> : <SearchIcon width="14" height="14" />}
          Search
        </button>
        {applied ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => {
              setQuery('');
              search('');
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      <p className="field__note" style={{ marginTop: 0 }}>
        {applied
          ? `Results for “${applied}” — ${rows.length} message${rows.length === 1 ? '' : 's'}, newest first.`
          : rows.length === 0
            ? 'No messages yet.'
            : `${rows.length} message${rows.length === 1 ? '' : 's'} loaded, newest first${hasMore ? ' — Load older reaches further back' : ' — that is the whole mailbox'}.`}{' '}
        Opening a row reads its full text straight away.
      </p>

      {error ? (
        <p className="sec__error">
          {error}{' '}
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void loadFirst(applied)}>
            Retry
          </button>
        </p>
      ) : null}

      {loading && rows.length === 0 ? (
        <p className="field__hint">
          <span className="spinner" /> Reading {account.address || 'the mailbox'}…
        </p>
      ) : null}

      {rows.length === 0 && !loading && loaded && !error && applied ? (
        <p className="field__hint">Nothing matched “{applied}”.</p>
      ) : null}

      <ul className="inbox__list login-messages__list msg-list">
        {rows.map((message) => {
          const key = `${message.accountId}:${message.id}`;
          const isOpen = expandedId === key;
          const stamp = Date.parse(message.issued || '');
          const when = Number.isNaN(stamp) ? '' : new Date(stamp).toLocaleString();
          const ago = !Number.isNaN(stamp) && message.issued ? relativeTime(stamp) : '';
          return (
            <li key={key} className="inbox__message" data-open={isOpen || undefined}>
              <button
                type="button"
                className="msg__head"
                aria-expanded={isOpen}
                aria-label={isOpen ? `Collapse: ${message.title || '(no subject)'}` : `Expand: ${message.title || '(no subject)'}`}
                onClick={() => setExpandedId(isOpen ? null : key)}
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
                  <span className="inbox__meta" title={shownFrom(message.author, message.email).title || undefined}>
                    {shownFrom(message.author, message.email).text || 'Unknown sender'}
                    {ago ? ` · ${ago}` : ''}
                  </span>
                </span>
              </button>
              {isOpen ? (
                <div className="login-messages__detail" onClick={(event) => event.stopPropagation()}>
                  <dl className="msg__fields">
                    <div className="msg__field">
                      <dt>From</dt>
                      <dd>{shownFrom(message.author, message.email).text || 'Unknown sender'}</dd>
                    </div>
                    <div className="msg__field">
                      <dt>Date</dt>
                      <dd>
                        {when || 'Unknown date'}
                        {ago ? ` (${ago})` : ''}
                      </dd>
                    </div>
                    <div className="msg__field">
                      <dt>Mailbox</dt>
                      <dd>{account.address}</dd>
                    </div>
                  </dl>
                  <span className="login-messages__actions">
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={() => onOpenExternal(gmailOpenUrl(message, account.address))}
                    >
                      Open in {accountLabel(account)}
                    </button>
                    <button type="button" className="btn btn--quiet btn--sm" onClick={() => setExpandedId(null)}>
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
                          onClick={() => {
                            requested.current.delete(key);
                            loadFullBody(key, mailTargetOf(account), message.id, message.title, message.author || message.email);
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

      {rows.length > 0 ? (
        <div className="mailbox__more">
          {hasMore && !applied ? (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? <span className="spinner" /> : null}
              Load older messages
            </button>
          ) : (
            <span className="field__hint" style={{ margin: 0 }}>
              {applied
                ? 'Searching one query at a time. Clear the search to page further back.'
                : 'This is every message in the mailbox.'}
            </span>
          )}
        </div>
      ) : null}

      {cachedOlder.length > 0 ? (
        <details className="mailbox__cached">
          <summary>
            {cachedOlder.length} earlier message{cachedOlder.length === 1 ? '' : 's'} already read on other
            screens
          </summary>
          <ul className="inbox__list login-messages__list msg-list">
            {cachedOlder.slice(0, 100).map((message) => (
              <li key={message.id} className="inbox__message">
                <span className="msg__head-text">
                  <span className="inbox__subject">{message.title || '(no subject)'}</span>
                  <span className="inbox__meta">
                    {(message.author || message.email) || 'Unknown sender'}
                    {message.issued ? ` · ${relativeTime(Date.parse(message.issued))}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The mailbox picker shared by the mail centre's tab strip.
 *
 * `Select` rather than a row of buttons: with ten connected mailboxes a tab
 * strip is a scrollbar, and the one the user wants is never the one on screen.
 * The buttons remain for small counts, which is the common case.
 */
export function MailboxTabs({
  accounts,
  activeId,
  onChange,
}: {
  accounts: GmailAccount[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  if (accounts.length <= 1) return null;
  if (accounts.length > 4) {
    return (
      <div className="mailbox__picker">
        <MailIcon width="15" height="15" />
        <Select
          value={activeId}
          label="Mailbox"
          options={accounts.map((account) => ({
            value: account.id,
            label: account.address || '(no address)',
          }))}
          onChange={onChange}
        />
      </div>
    );
  }
  return (
    <div className="mailbox__tabs" role="tablist" aria-label="Connected mailboxes">
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          role="tab"
          className="mailbox__tab"
          aria-selected={account.id === activeId}
          onClick={() => onChange(account.id)}
        >
          <MailIcon width="13" height="13" />
          {account.address || '(no address)'}
        </button>
      ))}
    </div>
  );
}
