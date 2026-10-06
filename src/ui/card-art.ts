/**
 * Card artwork for the carousel view.
 *
 * The upstream CircularCarousel renders <img> elements, so each login needs an
 * image. A login can supply its own background photo; otherwise we generate a
 * gradient card from its own accent hue. Both are self-contained data URIs, so
 * nothing identifying leaves the device.
 */

import type { CarouselItem } from '../components/react-bits/CircularCarousel.tsx';
import { MAX_IMAGE_EDGE, accentOf, hostnameOf, isAllowedImageSrc, type VaultItem } from '../vault/types.ts';

function toDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s{2,}/g, ' ').trim())}`;
}

/** The user's own photo, when they set one. */
export function backgroundSrc(item: VaultItem): string | null {
  const src = item.backgroundImage?.trim();
  if (!src) return null;
  return isAllowedImageSrc(src) ? src : null;
}

/**
 * Image for the avatar, if one was set separately.
 *
 * Falls back to the card background so existing logins keep the avatar they
 * already had; set an explicit avatar to override it.
 */
export function avatarSrc(item: VaultItem): string | null {
  const explicit = item.avatarImage?.trim();
  if (explicit && isAllowedImageSrc(explicit)) return explicit;
  return backgroundSrc(item);
}

export function cardArt(item: VaultItem, width = 600, height = 600): string {
  const hue = accentOf(item);
  const hue2 = (hue + 38) % 360;

  // This art is used as the ring card's background, and the ring draws the
  // title and subtitle on top of it in HTML. It used to bake a 150px initial
  // and the hostname into the SVG as well, so every card showed its hostname
  // twice and had a giant translucent letter sitting behind the label. The art
  // is now purely abstract: gradient, sheen and a soft vignette, and the text
  // is the renderer's job.
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 600 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 38% 56%)"/>
      <stop offset="55%" stop-color="hsl(${hue2} 34% 46%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 300) % 360} 30% 32%)"/>
    </linearGradient>
    <radialGradient id="s" cx="0.3" cy="0.2" r="0.9">
      <stop offset="0%" stop-color="hsl(0 0% 100% / 0.32)"/>
      <stop offset="60%" stop-color="hsl(0 0% 100% / 0)"/>
    </radialGradient>
    <linearGradient id="f" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="hsl(${hue} 30% 12% / 0.5)"/>
      <stop offset="100%" stop-color="hsl(${hue} 30% 12% / 0)"/>
    </linearGradient>
    <radialGradient id="v" cx="0.5" cy="0.5" r="0.75">
      <stop offset="55%" stop-color="hsl(0 0% 0% / 0)"/>
      <stop offset="100%" stop-color="hsl(${hue} 30% 8% / 0.34)"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <rect width="600" height="600" fill="url(#s)"/>
  <rect y="300" width="600" height="300" fill="url(#f)"/>
  <rect width="600" height="600" fill="url(#v)"/>
</svg>`;
  return toDataUri(svg);
}

export function toCarouselItem(item: VaultItem): CarouselItem {
  const label = item.title || item.url || 'Untitled';
  return {
    src: backgroundSrc(item) ?? cardArt(item),
    alt: label,
    title: label,
    // The orbit label prefers the saved address and falls back to the hostname,
    // so a card names itself with whatever the user actually recognises.
    subtitle: item.username || hostnameOf(item.url) || undefined,
  };
}

export function toCarouselItems(items: VaultItem[]): CarouselItem[] {
  return items.map(toCarouselItem);
}

/* ---- Style helpers used by the list views ------------------------------ */

/** CSS custom properties scoping one login's colour to its card. */
export function itemStyle(item: VaultItem): Record<string, string> {
  const hue = accentOf(item);
  return {
    '--item-h': String(hue),
    '--item-grad': `linear-gradient(135deg, hsl(${hue} 40% 58% / 0.9), hsl(${(hue + 34) % 360} 36% 52% / 0.75))`,
    '--item-soft': `linear-gradient(135deg, hsl(${hue} 40% 58% / 0.2), hsl(${(hue + 34) % 360} 36% 52% / 0.12))`,
  };
}

/**
 * Feeds the card's background image to CSS as variables rather than painting it
 * directly.
 *
 * The blur used to be a `filter` on the card element itself, which meant it also
 * blurred the title, username, password and buttons inside it. The image now
 * lives on its own `.item__art` layer, so the filter only ever touches pixels
 * that belong to the photo.
 */
export function itemBackgroundStyle(item: VaultItem): Record<string, string> {
  const src = backgroundSrc(item);
  if (!src) return {};
  return {
    '--item-art': `url("${src.replace(/["'()\\]/g, '\\$&')}")`,
    '--item-art-blur': `${Math.max(0, item.backgroundBlur ?? 0)}px`,
  } as Record<string, string>;
}

/**
 * Reads a user-selected image, downscales it and re-encodes it before storage.
 *
 * Storing a phone photo verbatim would mean megabytes of base64 per login, so
 * anything larger than MAX_IMAGE_EDGE is drawn to a canvas and re-encoded. WebP
 * is tried first and JPEG is the fallback for browsers without it.
 *
 * The size cap applies to the compressed result, so it can be generous.
 */
export function readImageFile(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('That file is not an image.'));
    // Reject absurd inputs before spending memory decoding them.
    if (file.size > 40_000_000) {
      return reject(new Error('That image is too large to process. Try one under 40 MB.'));
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const edge = Math.max(image.naturalWidth, image.naturalHeight);
        const scale = edge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / edge : 1;
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not process that image.');
        context.drawImage(image, 0, 0, width, height);

        const encoded = encodeLargest(canvas, width * height);
        URL.revokeObjectURL(url);

        if (encoded.length > maxBytes) {
          return reject(
            new Error(
              `That image is still ${Math.round(encoded.length / 1000)} KB after compressing. The limit is ${Math.round(
                maxBytes / 1000,
              )} KB.`,
            ),
          );
        }
        resolve(encoded);
      } catch (cause) {
        URL.revokeObjectURL(url);
        reject(cause instanceof Error ? cause : new Error('Could not read that image.'));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be decoded as an image.'));
    };
    image.src = url;
  });
}

/** Re-encodes at descending quality until the data URL fits the budget. */
function encodeLargest(canvas: HTMLCanvasElement, pixels: number): string {
  const budget = pixels > 1_200_000 ? 0.72 : pixels > 600_000 ? 0.8 : 0.86;
  let best = canvas.toDataURL('image/webp', budget);
  if (!best.startsWith('data:image/webp')) {
    best = canvas.toDataURL('image/jpeg', budget);
  }
  // WebP support is near universal now, but fall back if the browser silently
  // returned PNG (which happens for some canvas implementations).
  if (!best.startsWith('data:image/webp') && !best.startsWith('data:image/jpeg')) {
    best = canvas.toDataURL('image/jpeg', budget);
  }
  return best;
}