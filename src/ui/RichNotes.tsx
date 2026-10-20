/**
 * The notes editor. A contenteditable rather than a textarea so a paste can
 * keep the formatting it arrived with — bold, colours, lists, tables, spacing
 * — while the sanitiser in note-html.ts removes anything that could run,
 * track or overlay. Files take the attachment path instead of being pasted
 * inline, because they are encrypted with the login and bounded by the caps.
 *
 * The DOM is deliberately uncontrolled: React owns the wrapper, the browser
 * owns the caret. Writing `innerHTML` on every render would throw the cursor
 * to the end after each keystroke.
 */

import { useEffect, useMemo, useRef, type ClipboardEvent, type DragEvent } from 'react';
import { noteFilesFromTransfer } from './note-media.ts';
import { plainTextToHtml, sanitizeNoteHtml } from './note-html.ts';

function updateEmpty(editor: HTMLDivElement): void {
  const hasText = (editor.textContent ?? '').trim() !== '';
  const hasStructure = Boolean(editor.querySelector('table,hr'));
  editor.dataset.empty = hasText || hasStructure ? 'false' : 'true';
}

function insertHtml(editor: HTMLDivElement, html: string): boolean {
  try {
    if (document.execCommand('insertHTML', false, html)) return true;
  } catch {
    // Older renderers can refuse execCommand; the range path below still works.
  }
  const selection = window.getSelection();
  if (!selection) return false;
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

function insertPlainText(editor: HTMLDivElement, text: string): boolean {
  // Go through insertHtml rather than execCommand('insertText') so explicit
  // line breaks survive in every Chromium build; the latter may flatten them
  // into spaces depending on the caret's block.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>');
  return insertHtml(editor, `<span style="white-space: pre-wrap">${escaped}</span>`);
}

export function RichNotes({
  resetKey,
  html,
  text,
  placeholder,
  labelledBy,
  onChange,
  onFiles,
}: {
  /** A new item id (or "new") resets the DOM; ordinary re-renders must not. */
  resetKey: string;
  html?: string;
  text: string;
  placeholder?: string;
  labelledBy?: string;
  onChange: (next: { html: string; text: string }) => void;
  onFiles: (files: File[]) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const stored = html?.trim() ? sanitizeNoteHtml(html) : '';
    editor.innerHTML = stored || plainTextToHtml(text);
    updateEmpty(editor);
    // Reset only when the login changes. Depending on html/text here would
    // rewrite the DOM from the parent's echo of every keystroke and move the
    // caret to the end, which is exactly what an uncontrolled editor avoids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const sync = () => {
    const editor = editorRef.current;
    if (!editor) return;
    updateEmpty(editor);
    onChange({
      html: editor.innerHTML,
      text: editor.innerText.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    });
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = noteFilesFromTransfer(clipboard);
    if (files.length) {
      event.preventDefault();
      onFiles(files);
      return;
    }
    const rich = clipboard.getData('text/html');
    const plain = clipboard.getData('text/plain');
    if (!rich && !plain) return;
    event.preventDefault();
    const safe = rich ? sanitizeNoteHtml(rich) : '';
    if (safe) insertHtml(event.currentTarget, safe);
    else if (plain) insertPlainText(event.currentTarget, plain);
    sync();
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = noteFilesFromTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    onFiles(files);
  };

  return (
    <div className="rich-notes" onDragOver={onDragOver} onDrop={onDrop}>
      <div
        ref={editorRef}
        className="rich-notes__editor rich-text"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelledBy}
        data-placeholder={placeholder}
        data-empty="true"
        spellCheck
        onInput={sync}
        onPaste={onPaste}
        onBlur={() => {
          const editor = editorRef.current;
          if (!editor) return;
          const safe = sanitizeNoteHtml(editor.innerHTML);
          if (safe !== editor.innerHTML) editor.innerHTML = safe;
          updateEmpty(editor);
          sync();
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        }}
      />
    </div>
  );
}

/**
 * Read-only formatted notes. Falls back to the plain text for records saved
 * before rich notes existed, and sanitises again rather than trusting what is
 * in storage.
 */
export function RichNoteBody({ html, text }: { html?: string; text: string }) {
  const safe = useMemo(() => (html?.trim() ? sanitizeNoteHtml(html) : ''), [html]);
  if (!safe) return <div className="detail__notes">{text}</div>;
  return (
    <div
      className="detail__notes detail__notes--rich rich-text"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
