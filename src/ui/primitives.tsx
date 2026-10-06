import { useEffect, useRef, useState, type ReactNode } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { CheckIcon, XIcon } from './icons.tsx';
import type { Toast } from './hooks.ts';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  bodyClassName,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Replaces the body's padding, for content that manages its own layout. */
  bodyClassName?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key !== 'Tab' || !panel.current) return;
      // Keep focus inside the dialog while it is open.
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    // Prefer the first real form field. Focusing the close button would put a
    // focus ring on the least useful control in the dialog.
    const timer = setTimeout(() => {
      const target = panel.current?.querySelector<HTMLElement>(
        '.modal__body input:not([type="hidden"]), .modal__body textarea, .modal__body select',
      );
      (target ?? panel.current?.querySelector<HTMLElement>('.modal__footer .btn--primary'))?.focus();
    }, 40);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        className={wide ? 'modal modal--wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button className="btn btn--icon" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </header>
        <div className={bodyClassName ? `modal__body ${bodyClassName}` : 'modal__body'}>{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

const STRENGTH_COLORS = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--accent)', 'var(--accent)'];

export function StrengthMeter({ password }: { password: string }) {
  const strength = estimateStrength(password);
  return (
    <div className="strength">
      <div className="strength__bar">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className="strength__seg"
            style={{
              background:
                password && index <= strength.score
                  ? STRENGTH_COLORS[strength.score]
                  : 'var(--border)',
            }}
          />
        ))}
      </div>
      {password ? (
        <div className="strength__meta">
          <span className="strength__label" style={{ color: STRENGTH_COLORS[strength.score] }}>
            {strength.label}
          </span>
          <span className="strength__time">
            ~{strength.bits} bits · cracked in {strength.crackTime}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * Dropdown built from our own markup rather than a native `<select>`.
 *
 * The browser renders the native popup itself, outside the page: it ignores most
 * of our tokens and falls back to a system-light list, which on a dark theme looks
 * like a white flash and is hard to read. This draws the list with the same
 * surfaces as everything else, and adds arrow-key and type-ahead navigation.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  align = 'left',
}: {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange: (next: string) => void;
  /** Accessible name, since there is no visible <label> wired up. */
  label: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  // Start the highlight on whatever is currently chosen.
  useEffect(() => {
    if (!open) return;
    const index = options.findIndex((option) => option.value === value);
    setActive(index === -1 ? 0 : index);
  }, [open, value, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  /**
   * Escape closes just the list.
   *
   * Dialogs also listen for Escape on window, so this has to run in the capture
   * phase and stop propagation — otherwise dismissing the dropdown would close the
   * whole settings window as well.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActive((index) => (index + 1) % options.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((index) => (index - 1 + options.length) % options.length);
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(options.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(active);
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
        break;
    }
    // Type-ahead, same as the context menu.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = options.findIndex((option) => option.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (match !== -1) setActive(match);
    }
  }

  return (
    <div className="select" ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((state) => !state)}
      >
        <span className="select__value">{selected?.label}</span>
        <svg
          className="select__caret"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
          data-open={open || undefined}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="select__list" role="listbox" aria-label={label} data-align={align} ref={list}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              className="select__option"
              aria-selected={option.value === value}
              data-active={active === index || undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              <span className="select__option-icon" aria-hidden="true">
                {option.value === value ? <CheckIcon width="13" height="13" /> : null}
              </span>
              <span className="select__option-text">
                <span className="select__option-label">{option.label}</span>
                {option.hint ? <span className="select__option-hint">{option.hint}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={toast.tone === 'error' ? 'toast toast--error' : 'toast'}>
          <span className="toast__icon">
            {toast.tone === 'error' ? <XIcon width="14" height="14" /> : <CheckIcon width="14" height="14" />}
          </span>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`}>
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <h3 className="empty__title">{title}</h3>
      <p className="empty__text">{text}</p>
      {action}
    </div>
  );
}

/** Deterministic hue per label, so a site's colour never changes between loads. */
export function hueFor(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * Avatar tinted with the login's own accent hue, optionally over its background
 * photo. Reads the hue from the scoped CSS variable so a card and its avatar
 * always agree.
 */
export function Avatar({
  label,
  large,
  hue,
  background,
  onPhoto,
}: {
  label: string;
  large?: boolean;
  hue?: number;
  background?: string | null;
  /** True when the avatar sits on a photo, which needs a stronger edge. */
  onPhoto?: boolean;
}) {
  const initial = (label.trim()[0] ?? '?').toUpperCase();
  const h = hue ?? hueFor(label.trim() || 'aegis');
  const h2 = (h + 34) % 360;
  const classes = [large ? 'avatar avatar--lg' : 'avatar', onPhoto ? 'avatar--on-photo' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={
        background
          ? {
              backgroundImage: `url("${background.replace(/["'()\\]/g, '\\$&')}"), linear-gradient(135deg, hsl(${h} 40% 58%), hsl(${h2} 36% 46%))`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : { background: `linear-gradient(135deg, hsl(${h} 40% 56%), hsl(${h2} 36% 44%))` }
      }
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}