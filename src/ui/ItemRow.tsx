import { useEffect, useState } from 'react';
import { totpCode, totpSecondsRemaining } from '../crypto/totp.ts';
import { hostnameOf, type VaultItem } from '../vault/types.ts';
import { Avatar } from './primitives.tsx';
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ExternalIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  StarIcon,
  TrashIcon,
} from './icons.tsx';
import { useNow } from './hooks.ts';

const STALE_AFTER_DAYS = 180;

function isStale(item: VaultItem): boolean {
  return Date.now() - item.passwordUpdatedAt > STALE_AFTER_DAYS * 86_400_000;
}

function TotpRow({ secret, onCopy }: { secret: string; onCopy: (value: string, label: string) => void }) {
  const now = useNow(1000);
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void totpCode(secret, now)
      .then((value) => active && (setCode(value), setFailed(false)))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [secret, now]);

  const remaining = totpSecondsRemaining(now);
  if (failed) return <div className="detail__value detail__value--muted">Invalid authenticator key</div>;

  return (
    <div className="detail__value">
      <div className="totp">
        <span className="totp__ring" style={{ '--progress': (remaining / 30) * 100 } as never} />
        {code || '······'}
        <button
          className="btn btn--icon"
          onClick={() => onCopy(code, 'Authenticator code')}
          aria-label="Copy authenticator code"
          disabled={!code}
        >
          <CopyIcon />
        </button>
      </div>
    </div>
  );
}

export function ItemRow({
  item,
  expanded,
  revealed,
  revealAll,
  duplicateIds,
  onToggle,
  onToggleReveal,
  onEdit,
  onDelete,
  onCopy,
  onToggleFavorite,
  onOpenUrl,
}: {
  item: VaultItem;
  expanded: boolean;
  revealed: boolean;
  revealAll: boolean;
  duplicateIds: Set<string>;
  onToggle: () => void;
  onToggleReveal: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (value: string, label: string) => void;
  onToggleFavorite: () => void;
  onOpenUrl: () => void;
}) {
  const show = revealAll || revealed;
  const host = hostnameOf(item.url);
  const stale = isStale(item);
  const duplicated = duplicateIds.has(item.password) && item.password !== '';
  const label = item.title || item.username || host || 'Untitled';

  return (
    <>
      <div className={expanded ? 'item is-open' : 'item'}>
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flex: 1, minWidth: 0, textAlign: 'left' }}
        >
          <Avatar label={label} />
          <span className="item__body">
            <span className="item__title">
              {label}
              {item.favorite ? <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} /> : null}
              {duplicated ? <span className="chip chip--warn">reused</span> : null}
              {stale ? (
                <span className="chip chip--muted">
                  <ClockIcon width="11" height="11" />
                  old
                </span>
              ) : null}
            </span>
            <span className="item__meta">{item.username || item.url || 'No username'}</span>
          </span>
        </button>

        <div className="item__actions">
          <button
            className="btn btn--icon"
            onClick={onToggleFavorite}
            aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={item.favorite}
            style={item.favorite ? { color: 'var(--warn)' } : undefined}
          >
            <StarIcon filled={item.favorite} />
          </button>
          <button className="btn btn--icon" onClick={onEdit} aria-label="Edit">
            <KeyIcon />
          </button>
          <button className="btn btn--icon" onClick={onDelete} aria-label="Delete">
            <TrashIcon />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="detail">
          {item.username ? (
            <div className="detail__row">
              <span className="detail__label">Username</span>
              <span className="detail__value">{item.username}</span>
              <button
                className="btn btn--icon"
                onClick={() => onCopy(item.username, 'Username')}
                aria-label="Copy username"
              >
                <CopyIcon />
              </button>
            </div>
          ) : null}

          <div className="detail__row">
            <span className="detail__label">Password</span>
            <span className="detail__value detail__value--mono">
              {show ? item.password || '—' : '•'.repeat(Math.min(item.password.length || 8, 24))}
            </span>
            <span style={{ display: 'flex', gap: 2 }}>
              <button
                className="btn btn--icon"
                onClick={() => onCopy(item.password, 'Password')}
                aria-label="Copy password"
                disabled={!item.password}
              >
                <CopyIcon />
              </button>
              <button
                className="btn btn--icon is-active"
                onClick={onToggleReveal}
                aria-label={show ? 'Hide password' : 'Reveal password'}
                aria-pressed={show}
              >
                {show ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </span>
          </div>

          {item.totpSecret ? (
            <div className="detail__row">
              <span className="detail__label">Code</span>
              <TotpRow secret={item.totpSecret} onCopy={onCopy} />
              <span />
            </div>
          ) : null}

          {item.url ? (
            <div className="detail__row">
              <span className="detail__label">Website</span>
              <span className="detail__value">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: 'var(--accent-text)' }}
                >
                  {host ?? item.url}
                </a>
              </span>
              <button className="btn btn--icon" onClick={onOpenUrl} aria-label="Open website">
                <ExternalIcon />
              </button>
            </div>
          ) : null}

          {item.notes ? <div className="detail__notes">{item.notes}</div> : null}

          <div className="detail__actions">
            <button className="btn btn--secondary" onClick={onEdit}>
              Edit
            </button>
            <button className="btn btn--ghost" onClick={() => onCopy(item.password, 'Password')} disabled={!item.password}>
              <CheckIcon width="14" height="14" />
              Copy password
            </button>
            <button className="btn btn--danger" onClick={onDelete} style={{ marginLeft: 'auto' }}>
              <TrashIcon width="14" height="14" />
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}