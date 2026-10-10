/**
 * One message's complete body, fetched once and remembered for the session.
 *
 * Full bodies come over IMAP from the main process (see electron/mail-imap),
 * which a web page cannot do — so where `platform.mail` is absent the hook
 * reports unavailable and callers hide the affordance instead of a dead end.
 * Bodies are session-only: snippets accumulate in prefs, whole messages do
 * not, because one newsletter would outweigh a hundred cached snippets.
 */

import { useState } from 'react';
import { getPlatform } from '../lib/platform.ts';

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

  const load = (
    key: string,
    address: string,
    appPassword: string,
    feedId: string,
    subject?: string,
    from?: string,
  ) => {
    const mail = getPlatform().mail;
    if (!mail) return;
    setBodies((previous) => ({ ...previous, [key]: { status: 'loading' } }));
    void mail
      .fetchFullBody({ address, appPassword, feedId, subject, from })
      .then((result) => {
        setBodies((previous) => ({
          ...previous,
          [key]: result.ok
            ? { status: 'ok', text: result.text ?? '', html: result.html, images: result.images }
            : { status: 'error', error: result.error ?? 'Could not load the full message.' },
        }));
      })
      .catch(() => {
        setBodies((previous) => ({
          ...previous,
          [key]: { status: 'error', error: 'Could not load the full message.' },
        }));
      });
  };

  return { bodies, load, available };
}
