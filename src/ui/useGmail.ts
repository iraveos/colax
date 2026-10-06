import { useCallback, useEffect, useRef, useState } from 'react';

export interface GmailMessage {
  id: string;
  title: string;
  author: string;
  email: string;
  summary: string;
  issued: string;
  alternate: string;
}

const FEED_URL = 'https://mail.google.com/mail/feed/atom';

/** One fetch against the inbox feed; used by the polling hook and by "Test". */
export async function fetchGmailOnce(
  address: string,
  appPassword: string,
  setMessages?: (messages: GmailMessage[]) => void,
  setError?: (message: string | null) => void,
  setLoading?: (loading: boolean) => void,
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
    const messages = parseAtom(text);
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
 * Polls the Gmail inbox feed.
 *
 * Google still serves the Reader-era Atom feed at this endpoint, and it accepts
 * HTTP Basic with an account's *app password*, which is exactly what "a gmail
 * password that's created for apps" is. The same page must have the Origin
 * allowed; when the browser blocks the request we surface the error plainly.
 */
export function useGmail({
  enabled,
  address,
  appPassword,
  refreshSeconds,
}: {
  enabled: boolean;
  address: string;
  appPassword: string;
  refreshSeconds: number;
}) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Mirror for the effect below.
  const creds = useRef({ address, appPassword });
  creds.current = { address, appPassword };

  const fetchOnce = useCallback(() => fetchGmailOnce(creds.current.address, creds.current.appPassword, setMessages, setError, setLoading), []);

  useEffect(() => {
    if (!enabled || !address || !appPassword) return;
    void fetchOnce();
    const id = setInterval(() => void fetchOnce(), Math.max(2, refreshSeconds) * 1000);
    return () => clearInterval(id);
  }, [enabled, address, appPassword, refreshSeconds, fetchOnce]);

  return { messages, error, loading, refresh: fetchOnce };
}

function parseAtom(xml: string): GmailMessage[] {
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
    }));
  } catch {
    return [];
  }
}

function textOf(node: Element, tag: string): string {
  return node.getElementsByTagName(tag)[0]?.textContent ?? '';
}
