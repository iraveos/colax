/**
 * The receiving end of the browser capture.
 *
 * A content script in another tab sends a raw submission here. This hook turns
 * it into something the user can judge — a named site, an extracted email, and
 * the tags we would file it under — and hands it to a prompt. Nothing is written
 * to the vault until the user says save.
 *
 * All interpretation lives in `vault/site-intel.ts`, which is unit tested; this
 * file only wires that to the DOM and to the message channel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  captureToDraft,
  inspectCapture,
  type Capture,
  type CaptureInsight,
} from '../vault/site-intel.ts';
import type { Tag } from '../vault/channels.ts';

/** A capture that has been analysed and is waiting on the user. */
export interface PendingCapture {
  capture: Capture;
  insight: CaptureInsight;
}

export interface CaptureOfferOptions {
  /** Only listen while the vault is open; a locked vault cannot store anything. */
  enabled: boolean;
  /** Existing tags, so a near-identical one is reused rather than duplicated. */
  tags: Tag[];
  /** Fired when the user accepts. The caller owns the actual write. */
  onAccept: (offer: PendingCapture) => void;
}

export function useCaptureOffer({ enabled, tags, onAccept }: CaptureOfferOptions) {
  const [pending, setPending] = useState<PendingCapture | null>(null);

  // Held in a ref so the listener below can stay attached exactly once. A
  // re-subscribing listener on every render would drop captures in between.
  const acceptRef = useRef(onAccept);
  acceptRef.current = onAccept;

  const catalogue = useMemo(() => tags.map((tag) => ({ id: tag.id, name: tag.name })), [tags]);

  const receive = useCallback(
    (message: unknown) => {
      // The extension is a separate build and may not be installed, so every
      // field is checked rather than trusted.
      if (!message || typeof message !== 'object') return;
      const data = message as { type?: unknown; capture?: unknown };
      if (data.type !== 'colax:offer' || !data.capture || typeof data.capture !== 'object') return;

      const raw = data.capture as Partial<Capture>;
      const capture: Capture = {
        url: typeof raw.url === 'string' ? raw.url : '',
        host: typeof raw.host === 'string' ? raw.host : undefined,
        pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle : '',
        username: typeof raw.username === 'string' ? raw.username : '',
        password: typeof raw.password === 'string' ? raw.password : '',
        passwordConfirm: typeof raw.passwordConfirm === 'string' ? raw.passwordConfirm : undefined,
      };

      const insight = inspectCapture(capture, catalogue);
      // Only a capture we would actually store is worth interrupting for.
      if (insight.verdict !== 'save') return;

      setPending({ capture, insight });
    },
    [catalogue],
  );

  useEffect(() => {
    if (!enabled) return;

    const onMessage = (event: MessageEvent) => {
      // Anything can post a message to this window, so the payload is treated as
      // untrusted input and parsed rather than used. `inspectCapture` is pure and
      // makes no network calls, which is what makes that safe here.
      receive(event.data);
    };

    window.addEventListener('message', onMessage);
    // The extension's content script cannot post to a page it is not injected
    // into, so it goes through the background worker and back down this API.
    const fromExtension = ((event: MessageEvent) => receive(event.data)) as EventListener;
    extensionRuntime()?.onMessage?.addListener(fromExtension);

    return () => {
      window.removeEventListener('message', onMessage);
      extensionRuntime()?.onMessage?.removeListener(fromExtension);
    };
  }, [enabled, receive]);

  const accept = useCallback(() => {
    if (!pending) return;
    acceptRef.current(pending);
    setPending(null);
  }, [pending]);

  const dismiss = useCallback(() => {
    setPending(null);
    // Tell the extension so it stops prompting on this site.
    try {
      extensionRuntime()?.sendMessage?.({ type: 'colax:dismissed' });
    } catch {
      // Not installed, or the worker is asleep. The prompt is gone either way.
    }
  }, []);

  return { pending, accept, dismiss, buildDraft: (offer: PendingCapture) => captureToDraft(offer.capture, offer.insight) };
}

interface ExtensionRuntime {
  onMessage?: { addListener(cb: EventListener): void; removeListener(cb: EventListener): void };
  sendMessage?(message: unknown): void;
}

/**
 * The extension's messaging API, if one is present.
 *
 * Read off globalThis rather than naming `chrome` directly. Optional chaining
 * does not save you there: `chrome?.runtime` still throws ReferenceError when
 * `chrome` is an undeclared identifier, which is exactly what Firefox gives a
 * plain web page (Chrome exposes a `window.chrome` without `runtime`, so the
 * chain stops harmlessly — which is why this crashed only on Firefox).
 * Property access on globalThis never throws, present or not.
 */
function extensionRuntime(): ExtensionRuntime | undefined {
  return (globalThis as unknown as { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime;
}