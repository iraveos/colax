/**
 * One mailbox's messages in their own window, opened from a dock slot.
 *
 * A pared-down sibling of the per-login expander: no matching (a mailbox
 * window shows everything recent), but the same expandable rows, the same
 * persistent cache feeding them, and the same out-to-the-browser link.
 */

import { useEffect, useRef, useState } from 'react';
import { gmailOpenUrl, imapUidOf, listGmailOnce, useGmail, type GmailMessage } from './useGmail.ts';
import { gmailHexOf } from '../lib/mail-text.ts';
import { FullMail } from './FullMail.tsx';
import { useFullBody } from './useFullBody.ts';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import { relativeTime } from '../vault/types.ts';
import { Modal } from './primitives.tsx';
import { MailIcon } from './icons.tsx';

export function MailboxWindow({
  account,
  cache,
  onCacheMessages,
  onOpenExternal,
  onClose,
}: {
  account: GmailAccount;
  cache?: Record<string, CachedMailMessage[]>;
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
}) {
  // Manual checks only: no timer polls behind the user's back — one read on
  // open plus the Check now button. The accounts' cadence setting governs the
  // editor's live lists, not a window someone left open.
  const { messages, error, loading, refresh } = useGmail({ accounts: [account], onCacheMessages, auto: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { bodies: fullBodies, load: loadFullBody, available: canFullBody } = useFullBody();
  const cached = (cache?.[account.id] ?? []).filter(
    (entry) => !messages.some((live) => live.id === entry.id),
  );
  const all = [...messages, ...cached];
  // Full bodies fetch once per opened message, keyed by account:id. The set
  // survives re-renders so opening, closing and reopening never refetches.
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    requested.current.clear();
    setExpandedId(null);
  }, [account.id]);

  // The whole point of opening a row is reading the message: the full text
  // starts loading the moment it expands, with no extra button. One IMAP read
  // per message, only for rows the user actually opens.
  useEffect(() => {
    if (!expandedId || !canFullBody) return;
    if (requested.current.has(expandedId)) return;
    const message = all.find((entry) => `${account.id}:${entry.id}` === expandedId);
    // Feed ids resolve by Gmail id, IMAP rows by UID — anything else has no
    // addressable body and skips the fetch instead of erroring.
    if (!message || (!gmailHexOf(message.id) && !imapUidOf(message.id))) return;
    requested.current.add(expandedId);
    loadFullBody(
      expandedId,
      account.address,
      account.appPassword,
      message.id,
      message.title,
      message.author || message.email,
    );
  });

  return (
    <Modal
      title={account.address || 'Mailbox'}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn btn--secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? <span className="spinner" /> : <MailIcon width="14" height="14" />}
          Check now
        </button>
      }
    >
      <p className="field__note" style={{ marginTop: 0 }}>
        {all.length === 0
          ? 'No messages yet.'
          : `Showing all ${all.length} message${all.length === 1 ? '' : 's'} — newest first. Scroll to read them all.`}{' '}
        Opening a row loads its full text straight away. Select any text inside an open message freely;
        only the header row opens or closes it.
      </p>
      {error ? (
        <p className="sec__error">
          {error}{' '}
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {all.length === 0 && !loading ? (
        <p className="field__hint">No messages yet. Press Check now — new mail lands here as it is fetched.</p>
      ) : (
        <ul className="inbox__list login-messages__list msg-list">
          {all.map((message) => {
            const key = `${account.id}:${message.id}`;
            const isOpen = expandedId === key;
            const stamp = Date.parse(message.issued || '');
            const when = Number.isNaN(stamp) ? '' : new Date(stamp).toLocaleString();
            const ago = !Number.isNaN(stamp) && message.issued ? relativeTime(stamp) : '';
            return (
              <li key={key} className="inbox__message" data-open={isOpen || undefined}>
                {/* Only this header toggles. The detail below is a plain div
                    with no toggle handler, so selecting text inside it can
                    never collapse the row. */}
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
                    <span className="inbox__meta">
                      {message.author || message.email || 'Unknown sender'}
                      {message.email && message.author && message.email !== message.author
                        ? ` <${message.email}>`
                        : ''}
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
                        <dd>{[message.author, message.email].filter(Boolean).join(' · ') || 'Unknown sender'}</dd>
                      </div>
                      <div className="msg__field">
                        <dt>Date</dt>
                        <dd>{when || 'Unknown date'}{ago ? ` (${ago})` : ''}</dd>
                      </div>
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
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm"
                        onClick={() => onOpenExternal(gmailOpenUrl(message, account.address))}
                      >
                        Open in Gmail
                      </button>
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm"
                        onClick={() => setExpandedId(null)}
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
                            onClick={() => {
                              requested.current.delete(key);
                              loadFullBody(
                                key,
                                account.address,
                                account.appPassword,
                                message.id,
                                message.title,
                                message.author || message.email,
                              );
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
      )}
    </Modal>
  );
}

/** Re-checks one mailbox on demand and caches what comes back. Kept beside the
 *  window so callers that only need a refresh do not mount any UI. */
export async function refreshMailbox(
  account: GmailAccount,
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void,
): Promise<void> {
  const { messages: found } = await listGmailOnce(account.address, account.appPassword, account.id);
  if (found.length > 0) onCacheMessages?.(account.id, found);
}
