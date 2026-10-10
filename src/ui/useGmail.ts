import { useCallback, useEffect, useRef, useState } from 'react';
import type { GmailAccount } from '../vault/storage.ts';
import { feedIdOfDecimal, imapUidOf } from '../lib/mail-text.ts';
import { getPlatform } from '../lib/platform.ts';

export { imapUidOf };

export interface GmailMessage {
  id: string;
  title: string;
  author: string;
  email: string;
  summary: string;
  issued: string;
  alternate: string;
  /** Which connected account it came from. Empty for single-account callers. */
  accountId: string;
}

const FEED_URL = 'https://mail.google.com/mail/feed/atom';

/**
 * A Gmail link that survives the account switcher.
 *
 * The feed's bare deep link opens against whichever account the browser
 * happens to have first, and Google answers 403 when that is not the mailbox
 * the message came from. Pinning `/u/<address>` routes the link to the right
 * session, and the hex tail of the feed id addresses the message itself.
 * Falls back to a subject search, then to whatever link the feed carried.
 */
export function gmailOpenUrl(
  message: Pick<GmailMessage, 'id' | 'title' | 'alternate'>,
  accountAddress: string,
): string {
  const user = accountAddress.trim() ? encodeURIComponent(accountAddress.trim()) : '0';
  const rawId = message.id ?? '';
  const tail = rawId.includes(':') ? (rawId.split(':').pop() ?? '') : rawId;
  if (/^[0-9a-f]+$/i.test(tail)) return `https://mail.google.com/mail/u/${user}/#inbox/${tail}`;
  if (message.title) return `https://mail.google.com/mail/u/${user}/#search/${encodeURIComponent(message.title)}`;
  return message.alternate || 'https://mail.google.com';
}

/** One fetch against the inbox feed; used by the polling hook and by "Test". */
export async function fetchGmailOnce(
  address: string,
  appPassword: string,
  setMessages?: (messages: GmailMessage[]) => void,
  setError?: (message: string | null) => void,
  setLoading?: (loading: boolean) => void,
  accountId = '',
): Promise<GmailMessage[]> {
  if (!address || !appPassword) return [];
  setLoading?.(true);
  try {
    const response = await fetch(FEED_URL, {
      headers: { Authorization: `Basic ${btoa(`${address}:${appPassword}`)}` },
    });
    if (response.status === 401) {
      setError?.('Google rejected that login. Check the address and the app password (not the normal password).');
      setMessages?.([]);
      return [];
    }
    if (!response.ok) {
      setError?.(`Gmail answered ${response.status}. The inbox could not be read.`);
      return [];
    }
    const text = await response.text();
    const messages = parseAtom(text, accountId);
    setMessages?.(messages);
    setError?.(null);
    return messages;
  } catch {
    setError?.(
      'Could not reach Gmail. The browser blocks this request unless the page is allowed to call mail.google.com, so run the vault from a served origin or allow it in your browser settings.',
    );
    return [];
  } finally {
    setLoading?.(false);
  }
}

/**
 * Lists one mailbox: the Atom feed first (it carries snippets), IMAP second.
 *
 * The feed answers 401/403/empty since Google shut Basic-auth feed access
 * down, which used to read as "no messages" with no recourse. Where the feed
 * fails and the desktop shell is present, the same app password lists unread
 * headers straight over IMAP instead — no snippets, but real mail. The web
 * build has no IMAP, so there the feed error stands as the error.
 */
export async function listGmailOnce(
  address: string,
  appPassword: string,
  accountId = '',
): Promise<{ messages: GmailMessage[]; error: string | null }> {
  if (!address || !appPassword) return { messages: [], error: null };
  let feedMessages: GmailMessage[] = [];
  let feedError: string | null = null;
  await fetchGmailOnce(
    address,
    appPassword,
    (messages) => {
      feedMessages = messages;
    },
    (error) => {
      feedError = error;
    },
    undefined,
    accountId,
  );
  // Mail, or a clean empty inbox, ends here. Only a feed *error* falls
  // through to IMAP — and only where IMAP exists (desktop shell).
  if (feedMessages.length > 0 || feedError === null) {
    return { messages: feedMessages, error: feedError };
  }
  const listMail = getPlatform().mail?.listInbox;
  if (!listMail) return { messages: [], error: feedError };
  try {
    const listed = await listMail({ address, appPassword, limit: 20 });
    if (listed.ok && listed.messages) {
      return {
        messages: listed.messages.map((entry) => ({
          // A reported Gmail id becomes a real feed-style id; otherwise the
          // UID addresses the row and the UID path reads it back.
          id: feedIdOfDecimal(entry.gmailId) ?? `imap:${entry.uid}`,
          title: entry.subject,
          author: entry.fromName,
          email: entry.fromAddress,
          summary: '',
          issued: entry.date,
          alternate: '',
          accountId,
        })),
        error: null,
      };
    }
    return { messages: [], error: listed.error ?? 'The inbox could not be read.' };
  } catch {
    return { messages: [], error: 'The inbox could not be read.' };
  }
}

/**
 * Polls Gmail inbox feeds, one per enabled account.
 *
 * Google still serves the Reader-era Atom feed at this endpoint, and it accepts
 * HTTP Basic with an account's *app password*, which is exactly what "a gmail
 * password that's created for apps" is. The same page must have the Origin
 * allowed; when the browser blocks the request we surface the error plainly.
 *
 * Messages from all accounts merge newest-first. Per-account errors do not
 * wipe the other accounts' messages: a failing account reports its address in
 * the error and contributes nothing, rather than clearing a list it shares.
 */
export function useGmail({
  accounts,
  onCacheMessages,
  auto = true,
}: {
  accounts: GmailAccount[];
  /**
   * Every successful poll merges here too, so history accumulates passively —
   * the per-login expanders are not the only reads feeding the cache.
   */
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  /**
   * Poll on the accounts' cadence. Off means one read on mount plus manual
   * refreshes only — for windows the user, not a timer, is in charge of, so a
   * mailbox left open never hammers the server on its own.
   */
  auto?: boolean;
}) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Mirrored so the interval below never captures stale credentials.
  const creds = useRef(accounts);
  creds.current = accounts;
  // Guards overlapping ticks: the interval never stacks a second request on
  // top of one still in flight (that overlap is what got accounts throttled).
  const inFlight = useRef(false);
  const onCacheRef = useRef(onCacheMessages);
  onCacheRef.current = onCacheMessages;

  const fetchOnce = useCallback(async () => {
    if (inFlight.current) return;
    // A hidden window needs no fresh mail: skip the whole round trip (and, on
    // desktop, the IMAP connections behind it) until it is visible again.
    if (typeof document !== 'undefined' && document.hidden) return;
    const live = creds.current.filter((account) => account.enabled && account.address && account.appPassword);
    if (live.length === 0) {
      setMessages([]);
      return;
    }
    inFlight.current = true;
    setLoading(true);
    try {
      const perAccount = await Promise.all(
        live.map(async (account) => {
          const { messages: found, error: failed } = await listGmailOnce(
            account.address,
            account.appPassword,
            account.id,
          );
          return { account, found, failed };
        }),
      );
      const merged = perAccount
        .flatMap((entry) => entry.found)
        .sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''));
      setMessages(merged);
      for (const entry of perAccount) {
        if (!entry.failed && entry.found.length > 0) onCacheRef.current?.(entry.account.id, entry.found);
      }
      const failures = perAccount.filter((entry) => entry.failed);
      setError(
        failures.length === 0
          ? null
          : failures.map((entry) => `${entry.account.address || 'an account'}: ${entry.failed}`).join(' '),
      );
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  // A stable key for the live set: array identity changes on every keystroke
  // in the editor, but this only changes when credentials, enablement or the
  // chosen cadence actually change — so typing a password no longer fires a
  // request per character.
  const liveKey = accounts
    .filter((account) => account.enabled && account.address && account.appPassword)
    .map((account) => `${account.id}|${account.address.toLowerCase()}|${account.appPassword.length}|${account.refreshSeconds}`)
    .sort()
    .join(';');
  const autoKey = accounts
    .filter((account) => account.enabled && account.address && account.appPassword)
    .map((account) => `${account.id}:${account.refreshSeconds}`)
    .sort()
    .join(';');

  useEffect(() => {
    const live = creds.current.filter((account) => account.enabled && account.address && account.appPassword);
    if (live.length === 0) {
      setMessages([]);
      setError(null);
      return;
    }
    // Debounced first read: typing an address/password settles before any
    // network happens, instead of one request per keystroke.
    const timer = setTimeout(() => void fetchOnce(), 700);
    if (!auto) return () => clearTimeout(timer);
    // The user's own cadence drives the shared timer, exactly as chosen —
    // 5s and 30s included. Fast polling can earn a temporary Google block
    // (the buttons warn about it), but the choice is the user's, not ours.
    // A choice of 0 means manual only: the debounced first read plus the
    // Refresh / Check-now buttons, no interval at all.
    const wanted = live.map((account) =>
      typeof account.refreshSeconds === 'number' && account.refreshSeconds > 0 ? account.refreshSeconds : 0,
    );
    const chosen = Math.min(...wanted);
    if (!chosen || chosen <= 0) return () => clearTimeout(timer);
    const cadence = Math.max(5, chosen);
    const id = setInterval(() => void fetchOnce(), cadence * 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(id);
    };
    // liveKey/autoKey carry the semantic change; `accounts` identity alone
    // must not re-arm the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, autoKey, auto, fetchOnce]);

  return { messages, error, loading, refresh: fetchOnce };
}

function parseAtom(xml: string, accountId = ''): GmailMessage[] {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const entries = Array.from(doc.getElementsByTagName('entry'));
    return entries.map((entry) => ({
      id: textOf(entry, 'id'),
      title: textOf(entry, 'title'),
      author: entry.getElementsByTagName('author')[0]?.getElementsByTagName('name')[0]?.textContent ?? '',
      email: entry.getElementsByTagName('author')[0]?.getElementsByTagName('email')[0]?.textContent ?? '',
      summary: textOf(entry, 'summary'),
      issued: textOf(entry, 'issued'),
      alternate: entry.getElementsByTagName('link')[0]?.getAttribute('href') ?? 'https://mail.google.com',
      accountId,
    }));
  } catch {
    return [];
  }
}

function textOf(node: Element, tag: string): string {
  return node.getElementsByTagName(tag)[0]?.textContent ?? '';
}
