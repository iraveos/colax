import { useEffect, useRef, useState } from 'react';

export interface ClipCredentials {
  username: string;
  password: string;
}

/**
 * Watches the clipboard for what looks like a copied login and offers to save
 * it. Off by default; the user turns it on in Settings.
 *
 * Detection is deliberately conservative: an email-shaped line followed by a
 * non-trivial second line, or `email: password` on one line. Reading the
 * clipboard can be refused by the browser, which we treat as "nothing to do".
 */
export function useClipboardWatcher({
  enabled,
  unlocked,
  autoSave,
  onAutoSave,
}: {
  enabled: boolean;
  unlocked: boolean;
  autoSave: boolean;
  onAutoSave: (creds: ClipCredentials) => void;
}) {
  const [pending, setPending] = useState<ClipCredentials | null>(null);
  // The clipboard text we have already offered for, so the same copy does not
  // re-prompt until it changes.
  const seen = useRef<string>('');

  useEffect(() => {
    if (!enabled || !unlocked) return;
    let cancelled = false;

    const tick = async () => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return; // Permission denied or document not focused: nothing to offer.
      }
      if (cancelled || !text || text === seen.current) return;
      const creds = detect(text);
      if (!creds) return;
      seen.current = text;
      if (autoSave) onAutoSave(creds);
      else setPending(creds);
    };

    const id = setInterval(() => void tick(), 2500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, unlocked, autoSave, onAutoSave]);

  return {
    pending,
    dismiss: () => setPending(null),
  };
}

function detect(text: string): ClipCredentials | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return null;

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 2) {
    const [first, second] = lines;
    if (looksLikeLogin(first!) && looksLikePassword(second!)) {
      return { username: first!, password: second! };
    }
    // Either order works.
    if (looksLikePassword(first!) && looksLikeLogin(second!)) {
      return { username: second!, password: first! };
    }
  }

  // Single line "email: password" or "email password".
  const match = /^(\S+@\S+)[\s:]+(\S{6,})$/.exec(trimmed);
  if (match) return { username: match[1]!, password: match[2]! };

  return null;
}

function looksLikeLogin(value: string): boolean {
  return /\S+@\S+\.\S+/.test(value) || (!/\s/.test(value) && value.length >= 3 && value.length <= 64 && !/\s/.test(value));
}

function looksLikePassword(value: string): boolean {
  return value.length >= 6 && value.length <= 128 && !/^https?:\/\//i.test(value) && !value.includes('@');
}
