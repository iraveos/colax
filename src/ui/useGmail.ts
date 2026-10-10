import { useCallback, useEffect, useRef, useState } from 'react';
import type { GmailAccount } from '../vault/storage.ts';
import { imapUidOf } from '../lib/mail-text.ts';
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

/** Short non-crypto hash, so credential *changes* invalidate poll keys without storing secrets in them. */
export function credHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

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
  // Feed ids carry the Gmail hex id and deep-link straight to the message.
  // `imap:` rows carry a decimal UID, which is not a message id — those fall
  // through to the subject search instead of a mispointed deep link.
  if (!rawId.startsWith('imap:') && /^[0-9a-f]+$/i.test(tail)) {
    return `https://mail.google.com/mail/u/${user}/#inbox/${tail}`;
  }
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
 * Lists one mailbox, newest first.
 *
 * Desktop reads its own IMAP directly: one path, no feed round-trip. The
 * Atom feed is web-only now — on desktop it only ever produced errors, CORS
 * failures, or unread-only emptiness that hid the real mailbox. The web
 * build has no IMAP, so there the feed is the only read available.
 */
export async function listGmailOnce(
  address: string,
  appPassword: string,
  accountId = '',
): Promise<{ messages: GmailMessage[]; error: string | null }> {
  if (!address || !appPassword) return { messages: [], error: null };
  const listMail = getPlatform().mail?.listInbox;
  if (listMail) {
    try {
      const listed = await listMail({ address, appPassword, limit: 20 });
      if (listed.ok && listed.messages) {
        return {
          messages: listed.messages.map((entry) => ({
            id: `imap:${entry.uid}`,
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
  return { messages: feedMessages, error: feedError };
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
  // request per character. The password itself is hashed in, not just its
  // length: correcting a wrong password with another of the same length must
  // still refetch, or fixed credentials silently keep showing the old error.
  const liveKey = accounts
    .filter((account) => account.enabled && account.address && account.appPassword)
    .map((account) => `${account.id}|${account.address.toLowerCase()}|${credHash(account.appPassword)}|${account.refreshSeconds}`)
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
