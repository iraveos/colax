import { useCallback, useEffect, useRef, useState } from 'react';
import type { GmailAccount } from '../vault/storage.ts';

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
export function useGmail({ accounts }: { accounts: GmailAccount[] }) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Mirrored so the interval below never captures stale credentials.
  const creds = useRef(accounts);
  creds.current = accounts;

  const fetchOnce = useCallback(async () => {
    const live = creds.current.filter((account) => account.enabled && account.address && account.appPassword);
    if (live.length === 0) {
      setMessages([]);
      return;
    }
    setLoading(true);
    try {
      const perAccount = await Promise.all(
        live.map(async (account) => {
          let failed: string | null = null;
          const found = await fetchGmailOnce(account.address, account.appPassword, undefined, (message) => {
            failed = message;
          }, undefined, account.id);
          return { account, found, failed };
        }),
      );
      const merged = perAccount
        .flatMap((entry) => entry.found)
        .sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''));
      setMessages(merged);
      const failures = perAccount.filter((entry) => entry.failed);
      setError(
        failures.length === 0
          ? null
          : failures.map((entry) => `${entry.account.address || 'an account'}: ${entry.failed}`).join(' '),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const live = accounts.filter((account) => account.enabled && account.address && account.appPassword);
    if (live.length === 0) {
      setMessages([]);
      setError(null);
      return;
    }
    void fetchOnce();
    // Fastest cadence among the accounts drives the shared timer; slower
    // accounts simply return cached-fresh results more often than needed, which
    // costs one cheap feed read, not correctness.
    const cadence = Math.max(2, Math.min(...live.map((account) => account.refreshSeconds)));
    const id = setInterval(() => void fetchOnce(), cadence * 1000);
    return () => clearInterval(id);
  }, [accounts, fetchOnce]);

  return { messages, error, loading, refresh: fetchOnce };
}

function parseAtom(xml: string, accountId = ''): GmailMessage[] {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const entries = [...doc.getElementsByTagName('entry')];
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
