/**
 * One message's complete body, fetched once and remembered for the session.
 *
 * Full bodies come over IMAP from the main process (see electron/mail-imap),
 * which a web page cannot do — so where `platform.mail` is absent the hook
 * reports unavailable and callers hide the affordance instead of a dead end.
 * Bodies are session-only: snippets accumulate in prefs, whole messages do
 * not, because one newsletter would outweigh a hundred cached snippets.
 *
 * What is remembered is bounded. A body can carry megabytes of inline images,
 * so this hook keeps only the most recently opened messages and forgets the
 * rest; reopening a row simply fetches it again, which is what the row's
 * loading state is for. The cap is fixed rather than a preference: it is
 * invisible unless a single view has opened more messages than it can show,
 * and a tuning knob nobody reads is a worse use of the Optimize tab than a
 * number that just works.
 */

import { useState } from 'react';
import { getPlatform } from '../lib/platform.ts';
import { normAppPassword, normMailAddress, type MailTarget } from './useGmail.ts';

/** How many opened messages one view remembers before the oldest fall off. */
const MAX_BODIES = 16;

/** Keeps the newest keys, in order, and drops the rest. */
function capBodies(next: Record<string, FullBodyState>): Record<string, FullBodyState> {
  const keys = Object.keys(next);
  if (keys.length <= MAX_BODIES) return next;
  const trimmed: Record<string, FullBodyState> = {};
  for (const key of keys.slice(-MAX_BODIES)) {
    const state = next[key];
    if (state) trimmed[key] = state;
  }
  return trimmed;
}

export interface FullBodyImage {
  cid: string;
  mime: string;
  dataUrl: string;
}

export interface FullBodyState {
  status: 'loading' | 'ok' | 'error';
  text?: string;
  /** Raw HTML body, when the message carries one. Sanitized at render. */
  html?: string;
  /** Inline images referenced by the HTML, by content id. */
  images?: FullBodyImage[];
  error?: string;
}

export function useFullBody() {
  const [bodies, setBodies] = useState<Record<string, FullBodyState>>({});
  const available = typeof getPlatform().mail?.fetchFullBody === 'function';

  /**
   * Fetches one message's whole body.
   *
   * The target carries the account's own server, so a Yahoo or work mailbox
   * reads its message rather than being pointed at Google's endpoint — the
   * field that used to make any non-Gmail account look broken.
   *
   * `images` false asks the reader to skip the inline-image fetches — the
   * Optimize tab's per-message memory saving. The body still loads.
   */
  const load = (key: string, target: MailTarget, feedId: string, subject?: string, from?: string, images = true) => {
    const mail = getPlatform().mail;
    if (!mail) return;
    setBodies((previous) => capBodies({ ...previous, [key]: { status: 'loading' } }));
    void mail
      .fetchFullBody({
        address: normMailAddress(target.address),
        appPassword: normAppPassword(target.appPassword),
        host: target.host,
        port: target.port,
        secure: target.secure,
        feedId,
        subject,
        from,
        images,
      })
      .then((result) => {
        setBodies((previous) =>
          capBodies({
            ...previous,
            [key]: result.ok
              ? { status: 'ok', text: result.text ?? '', html: result.html, images: result.images }
              : { status: 'error', error: result.error ?? 'Could not load the full message.' },
          }),
        );
      })
      .catch(() => {
        // The request itself broke down (transport, timeout, oversized
        // payload) rather than the server refusing: say so, so Retry reads
        // as useful and Open in Gmail reads as the way out.
        setBodies((previous) =>
          capBodies({
            ...previous,
            [key]: { status: 'error', error: 'The transfer failed. Retry, or open in Gmail instead.' },
          }),
        );
      });
  };

  return { bodies, load, available };
}
