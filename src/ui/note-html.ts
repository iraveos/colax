/**
 * Rich notes are HTML, so they cross two trust boundaries: whatever another
 * app put on the clipboard, and whatever a hand-edited or imported vault
 * carries. Both go through this one sanitiser before they touch the DOM.
 *
 * The goal is formatting fidelity without giving pasted markup a way to run
 * script, load a tracker, cover the app or phone home. Inline styles are kept
 * for the properties that describe text and tables (fonts, colours, spacing,
 * borders); positioning, animation, URLs and anything that can hide or overlay
 * the interface are dropped. Stylesheets, images and media are deliberately
 * stripped: pasted pictures already travel through the attachment path, where
 * they are encrypted and bounded, and remote images would be tracking pixels.
 */

import DOMPurify from 'dompurify';

const SAFE_STYLE_PROPERTIES = new Set([
  'background-color',
  'border',
  'border-bottom',
  'border-collapse',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-spacing',
  'border-style',
  'border-top',
  'border-width',
  'color',
  'direction',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-variant-caps',
  'font-weight',
  'height',
  'letter-spacing',
  'line-height',
  'list-style-position',
  'list-style-type',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'overflow-wrap',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'table-layout',
  'text-align',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-indent',
  'text-transform',
  'unicode-bidi',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
  'word-spacing',
]);

const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding/i;

function sanitiseStyle(style: string): string {
  const probe = document.createElement('span');
  probe.setAttribute('style', style);
  const kept: string[] = [];
  for (let index = 0; index < probe.style.length; index += 1) {
    const property = probe.style.item(index);
    if (!SAFE_STYLE_PROPERTIES.has(property)) continue;
    const value = probe.style.getPropertyValue(property).trim();
    if (!value || UNSAFE_STYLE_VALUE.test(value)) continue;
    kept.push(`${property}: ${value}`);
  }
  return kept.join('; ');
}

/** The formatting HTML that is safe to store and render. */
export function sanitizeNoteHtml(html: string): string {
  if (!html) return '';
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      'style',
      'align',
      'valign',
      'bgcolor',
      'border',
      'cellpadding',
      'cellspacing',
      'colspan',
      'rowspan',
      'width',
      'height',
      'dir',
      'lang',
      'color',
      'face',
      'size',
    ],
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'link',
      'meta',
      'base',
      'noscript',
      'template',
      'img',
      'picture',
      'source',
      'video',
      'audio',
      'canvas',
      'svg',
      'math',
    ],
    FORBID_CONTENTS: [
      'script',
      'style',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'noscript',
      'template',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'poster', 'background', 'contenteditable', 'tabindex'],
    ALLOW_DATA_ATTR: false,
  });

  const host = document.createElement('div');
  host.innerHTML = clean;
  for (const element of Array.from(host.querySelectorAll('*'))) {
    element.removeAttribute('id');
    element.removeAttribute('class');
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? '';
      if (/^https?:|^mailto:/i.test(href)) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      } else {
        element.removeAttribute('href');
      }
    }
    const style = element.getAttribute('style');
    if (!style) continue;
    const safe = sanitiseStyle(style);
    if (safe) element.setAttribute('style', safe);
    else element.removeAttribute('style');
  }

  const text = (host.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  if (!text && !host.querySelector('table,hr')) return '';
  return host.innerHTML;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Old plain-text notes become the editor's initial blocks. */
export function plainTextToHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<div style="white-space: pre-wrap">${line.trim() === '' ? '<br>' : escapeHtml(line)}</div>`)
    .join('');
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  if (node.tagName === 'BR') return '\n';
  let out = '';
  for (const child of Array.from(node.childNodes)) out += nodeText(child);
  if (node.tagName === 'TD' || node.tagName === 'TH') out += '\t';
  if (BLOCK_TAGS.has(node.tagName)) out = `\n${out}\n`;
  return out;
}

/** Plain text for search, cards, exports and the history list. */
export function noteHtmlToText(html: string): string {
  const safe = sanitizeNoteHtml(html);
  if (!safe) return '';
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  return nodeText(doc.body)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
