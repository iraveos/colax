/**
 * A full message body, rendered as close to Gmail as is safe.
 *
 * HTML mail is hostile by default — scripts, tracking pixels, remote images
 * that phone home. So the HTML is scrubbed with DOMPurify before it touches
 * the DOM (no scripts, no forms, no inline event handlers, no remote styles),
 * inline `cid:` images resolve against the parts fetched over IMAP, and
 * remote images never load: each becomes a labelled placeholder instead, the
 * way Gmail itself holds them back. Links never open in place — a click hands
 * them to the real browser, because `window.open` inside Electron spawns a
 * second app window. Without an HTML part this renders the plain text as
 * before, so text-only mail reads exactly like it always did.
 */

import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { FullBodyImage } from './useFullBody.ts';

function stripCidBrackets(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

export function FullMail({
  html,
  text,
  images,
  onOpenExternal,
}: {
  /** Raw HTML from IMAP, if the message carries any. */
  html?: string;
  /** Plain-text fallback. */
  text?: string;
  images?: FullBodyImage[];
  onOpenExternal?: (url: string) => void;
}) {
  const rich = useMemo(() => {
    if (!html) return null;
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'frame', 'object', 'embed', 'base', 'link', 'meta', 'noscript'],
      FORBID_ATTR: ['style', 'background', 'srcset', 'action', 'formaction'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    const host = document.createElement('div');
    host.innerHTML = clean;
    const byCid = new Map<string, string>();
    for (const image of images ?? []) byCid.set(stripCidBrackets(image.cid).toLowerCase(), image.dataUrl);
    for (const img of Array.from(host.querySelectorAll('img'))) {
      const src = (img.getAttribute('src') || '').trim();
      const cid = src.toLowerCase().startsWith('cid:') ? stripCidBrackets(src.slice(4)).toLowerCase() : null;
      const dataUrl = cid ? byCid.get(cid) : undefined;
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
        img.removeAttribute('srcset');
        continue;
      }
      // Remote or unresolvable: a labelled stand-in, never a silent hole and
      // never a network call behind the user's back.
      const standIn = document.createElement('span');
      standIn.className = 'full-mail__blocked';
      const alt = (img.getAttribute('alt') || '').trim();
      standIn.textContent = alt ? `Image blocked: ${alt}` : 'Remote image blocked — open in Gmail to view it.';
      img.replaceWith(standIn);
    }
    // Links leave through the platform seam, like every other message link.
    for (const anchor of Array.from(host.querySelectorAll('a[href]'))) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
    return host.innerHTML;
  }, [html, images]);

  if (rich) {
    return (
      <span
        className="full-mail full-mail--rich"
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest?.('a[href]');
          const href = anchor?.getAttribute('href');
          if (!anchor || !href || !onOpenExternal) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenExternal(href);
        }}
      >
        <span
          // Sanitized above: scripts, handlers, remote images and unknown
          // protocols never survive into this string.
          dangerouslySetInnerHTML={{ __html: rich }}
        />
      </span>
    );
  }
  return <span className="full-mail">{text}</span>;
}
