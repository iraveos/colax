/**
 * A Mohmal disposable inbox, shown in the same message-window shape as the
 * regular mailbox viewer.
 *
 * The network work lives in the main process (see electron/temp-mail.ts); this
 * component only renders headers and asks for one body at a time. Message bodies
 * go through FullMail, so Mohmal's HTML is sanitised and remote images never
 * load behind the user's back.
 */

import { useEffect, useRef, useState } from 'react';
import { getPlatform } from '../lib/platform.ts';
import {
  tempMailRemainingLabel,
  type TempMailDetail,
  type TempMailMessage,
  type TempMailbox,
} from '../lib/temp-mail.ts';
import { FullMail } from './FullMail.tsx';
import { CopyIcon, InboxIcon } from './icons.tsx';

export function TempMailMessages({
  mailbox,
  onNotify,
  onOpenExternal,
}: {
  mailbox: TempMailbox;
  onNotify?: (message: string, tone?: 'ok' | 'error') => void;
  onOpenExternal?: (url: string) => void;
}) {
  const [messages, setMessages] = useState<TempMailMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [detail, setDetail] = useState<TempMailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [expiresAt, setExpiresAt] = useState(mailbox.expiresAt);
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);

  async function refresh(): Promise<void> {
    const api = getPlatform().tempMail;
    if (!api) {
      setMessages([]);
      setError('Temporary mail needs the Colax desktop app.');
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.list(mailbox.address, mailbox.sessionKey);
      if (request !== requestRef.current) return;
      if (!result.ok) {
        setMessages([]);
        setError(result.error);
        return;
      }
      setMessages(result.messages);
      if (result.expiresAt) setExpiresAt(result.expiresAt);
    } catch (cause) {
      if (request !== requestRef.current) return;
      setMessages([]);
      setError(cause instanceof Error ? cause.message : 'Could not read this temporary inbox.');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  async function open(message: TempMailMessage): Promise<void> {
    if (openId === message.id) {
      setOpenId('');
      setDetail(null);
      return;
    }
    setOpenId(message.id);
    setDetail(null);
    setDetailError('');
    const request = ++detailRequestRef.current;
    const api = getPlatform().tempMail;
    if (!api) {
      setDetailError('Temporary mail needs the Colax desktop app.');
      return;
    }
    setDetailLoading(true);
    try {
      const result = await api.read(mailbox.address, mailbox.sessionKey, message.id);
      if (request !== detailRequestRef.current) return;
      if (!result.ok) {
        setDetailError(result.error);
        return;
      }
      setDetail(result.message);
    } catch (cause) {
      if (request !== detailRequestRef.current) return;
      setDetailError(cause instanceof Error ? cause.message : 'Could not open this message.');
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // The inbox is disposable and short-lived; a ten-second poll while the
    // viewer is open is enough to catch a confirmation mail without turning
    // Mohmal into a background poller.
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox.address, mailbox.sessionKey]);

  const expiry = tempMailRemainingLabel({ ...mailbox, expiresAt });
  const count = messages?.length ?? 0;

  return (
    <div className="temp-mail">
      <div className="temp-mail__head">
        <div className="temp-mail__identity">
          <span className="field__label">
            <InboxIcon width="13" height="13" /> Mohmal temporary inbox
          </span>
          <code className="temp-mail__address">{mailbox.address}</code>
          <span className="field__hint">
            {expiry === 'expired' ? 'This inbox has expired.' : `${expiry[0]?.toUpperCase()}${expiry.slice(1)}.`}{' '}
            New mail is checked every few seconds while this window is open.
          </span>
        </div>
        <div className="temp-mail__actions">
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(mailbox.address)
                .then(() => onNotify?.('Temporary address copied'))
                .catch(() => onNotify?.('Could not reach the clipboard', 'error'));
            }}
          >
            <CopyIcon width="12" height="12" /> Copy address
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? <span className="spinner" /> : null} Refresh
          </button>
        </div>
      </div>

      {error ? <p className="sec__error">{error}</p> : null}
      {messages === null && loading ? (
        <p className="field__hint">Opening the temporary inbox…</p>
      ) : messages !== null && messages.length === 0 && !error ? (
        <div className="temp-mail__empty">
          <InboxIcon width="22" height="22" />
          <p>No messages yet.</p>
          <span className="field__hint">
            Use {mailbox.address} on the site, then leave this window open or press Refresh.
          </span>
        </div>
      ) : messages !== null ? (
        <ul className="inbox__list login-messages__list msg-list">
          {messages.map((message) => {
            const isOpen = openId === message.id;
            return (
              <li key={message.id} className="inbox__message" data-open={isOpen || undefined}>
                <button
                  type="button"
                  className="msg__head"
                  aria-expanded={isOpen}
                  onClick={() => void open(message)}
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
                    <span className="inbox__subject">
                      {message.unread ? <span className="temp-mail__unread" aria-label="Unread" /> : null}
                      {message.subject || '(no subject)'}
                    </span>
                    <span className="inbox__meta">
                      {message.from || 'Unknown sender'}
                      {message.time ? ` · ${message.time}` : ''}
                    </span>
                  </span>
                </button>
                {isOpen ? (
                  <div className="login-messages__detail">
                    <dl className="msg__fields">
                      <div className="msg__field">
                        <dt>From</dt>
                        <dd>{message.from || 'Unknown sender'}</dd>
                      </div>
                      <div className="msg__field">
                        <dt>Subject</dt>
                        <dd>{message.subject || '(no subject)'}</dd>
                      </div>
                      {message.time ? (
                        <div className="msg__field">
                          <dt>Received</dt>
                          <dd>{message.time}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {detailLoading && openId === message.id ? (
                      <span className="field__hint">Loading message…</span>
                    ) : detailError && openId === message.id ? (
                      <span className="field__hint">{detailError}</span>
                    ) : detail && openId === message.id ? (
                      <FullMail
                        html={detail.html}
                        text={detail.text}
                        onOpenExternal={onOpenExternal}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="field__hint temp-mail__count">
        {count > 0 ? `${count} message${count === 1 ? '' : 's'}` : 'Mohmal deletes the inbox and its mail when the validity time ends.'}
      </p>
    </div>
  );
}
