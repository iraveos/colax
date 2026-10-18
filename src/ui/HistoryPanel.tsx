/**
 * The History channel: everything that happened to every login, newest first.
 *
 * Two things make this more than a read-only log. Deleted and edited logins
 * carry the version they replaced, so a row can put it *back* — an edit that
 * wiped a password and a delete of the wrong row are both recoverable, which is
 * otherwise impossible once the record is gone. And the whole log is searchable
 * by name, address, URL and action, because "find the login I deleted last
 * Tuesday" is the reason to have a log at all.
 *
 * Rows are grouped by day: a flat list of timestamps is a wall of "3 minutes
 * ago" with no shape to it. Counts, labels and empty states all come from the
 * events themselves, so nothing here can disagree with what was recorded.
 */

import { useMemo, useState } from 'react';
import { ClockIcon, CopyIcon, EditIcon, ExternalIcon, SearchIcon, TrashIcon, UploadIcon } from './icons.tsx';
import { EmptyState } from './primitives.tsx';
import { hostnameOf, relativeTime, type VaultItem } from '../vault/types.ts';
import type { HistoryEvent } from '../vault/storage.ts';

const ACTION_LABELS: Record<HistoryEvent['action'], string> = {
  added: 'Added',
  edited: 'Edited',
  deleted: 'Deleted',
};

/** Day name for the group headers, so the log reads as a diary. */
function dayLabel(at: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const midnight = start.getTime();
  if (at >= midnight) return 'Today';
  if (at >= midnight - 86_400_000) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

export interface HistoryPanelProps {
  events: HistoryEvent[];
  /** Logins that still exist, for the rows a restore would collide with. */
  items: VaultItem[];
  /** Writes an event's snapshot back. Absent when the event has none. */
  onRestore: (event: HistoryEvent) => void;
  /** Opens the live login for an event that still exists. */
  onOpenLogin: (item: VaultItem) => void;
  /** Copies a value, counted as use like every other copy in the app. */
  onCopy: (value: string, label: string, item?: VaultItem) => void;
  /** Removes one event from the log. */
  onForget: (id: string) => void;
  onClear: () => void;
  /** True while the vault is doing the write, so rows cannot be double-fired. */
  busy?: boolean;
  /**
   * Rendered inside another screen (the Dashboard's History tab) rather than as
   * a channel's own page. Only the outer padding and the page-level wrapper
   * change: the panel is deliberately one component, so the tab and the channel
   * can never drift apart.
   */
  embedded?: boolean;
}

export function HistoryPanel({
  events,
  items,
  onRestore,
  onOpenLogin,
  onCopy,
  onForget,
  onClear,
  busy,
  embedded = false,
}: HistoryPanelProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | HistoryEvent['action']>('all');
  const now = Date.now();

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      if (filter !== 'all' && event.action !== filter) return false;
      if (!needle) return true;
      const item = byId.get(event.itemId);
      const haystack = [
        event.title,
        event.username,
        event.before?.url ?? '',
        item?.url ?? '',
        ACTION_LABELS[event.action],
        event.before?.notes ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [events, filter, query, byId]);

  const groups = useMemo(() => {
    const out: { label: string; events: HistoryEvent[] }[] = [];
    for (const event of shown) {
      const label = dayLabel(event.at, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.events.push(event);
      else out.push({ label, events: [event] });
    }
    return out;
  }, [shown, now]);

  return (
    <div className={embedded ? 'history history--embedded' : 'content__inner content__inner--dash history'}>
      <header className="history__head">
        <div className="history__title">
          <ClockIcon width="18" height="18" />
          {embedded ? null : <h2>History</h2>}
          <span className="history__count">
            {events.length === 1 ? '1 change' : `${events.length} changes`}
          </span>
        </div>
        <p className="field__hint">
          Every login that was added, edited or deleted, newest first. A row with a stored version offers
          Restore, which puts that version back — including a login that was deleted.
        </p>
        <div className="history__tools">
          <label className="search history__search">
            <SearchIcon className="search__icon" width="15" height="15" />
            <input
              className="search__input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the history — name, address, site or action"
              aria-label="Search history"
            />
          </label>
          <div className="segmented history__filter">
            {(['all', 'added', 'edited', 'deleted'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="segmented__option"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'All' : ACTION_LABELS[value]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={onClear}
            disabled={events.length === 0}
          >
            Clear log
          </button>
        </div>
      </header>

      {events.length === 0 ? (
        <EmptyState
          icon={<ClockIcon width="22" height="22" />}
          title="Nothing has changed yet"
          text="Add, edit or delete a login and it shows up here — with the previous version kept, so a change can be undone."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<SearchIcon width="22" height="22" />}
          title="No matching changes"
          text="Try a different word, or switch the filter back to All."
        />
      ) : (
        <div className="history__groups">
          {groups.map((group) => (
            <section key={group.label} className="history__group">
              <h3 className="history__day">{group.label}</h3>
              <ul className="history__list">
                {group.events.map((event) => {
                  const live = byId.get(event.itemId);
                  const url = live?.url || event.before?.url || '';
                  const password = event.before?.password ?? '';
                  return (
                    <li key={event.id} className="history__row" data-action={event.action}>
                      <span className="history__badge" data-action={event.action}>
                        {ACTION_LABELS[event.action]}
                      </span>
                      <span className="history__what">
                        <span className="history__name">{event.title || 'Untitled'}</span>
                        <span className="history__meta">
                          {event.username || 'no username'}
                          {url ? ` · ${hostnameOf(url) || url}` : ''} · {relativeTime(event.at, now)}
                          {live ? '' : ' · no longer in the vault'}
                        </span>
                      </span>
                      <span className="history__actions">
                        {event.before ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => onRestore(event)}
                            disabled={busy}
                            title={
                              event.action === 'deleted'
                                ? 'Put this login back, exactly as it was'
                                : 'Put this earlier version back'
                            }
                          >
                            <UploadIcon width="13" height="13" />
                            Restore
                          </button>
                        ) : null}
                        {live ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--icon btn--sm"
                              title="Edit this login"
                              aria-label="Edit this login"
                              onClick={() => onOpenLogin(live)}
                            >
                              <EditIcon width="14" height="14" />
                            </button>
                            {password ? (
                              <button
                                type="button"
                                className="btn btn--icon btn--sm"
                                title="Copy the password this row restored to"
                                aria-label="Copy password from history"
                                onClick={() => onCopy(password, 'Password from history', live)}
                              >
                                <CopyIcon width="14" height="14" />
                              </button>
                            ) : null}
                            {url ? (
                              <button
                                type="button"
                                className="btn btn--icon btn--sm"
                                title="Copy the address"
                                aria-label="Copy address"
                                onClick={() => onCopy(url, 'Address from history', live)}
                              >
                                <ExternalIcon width="14" height="14" />
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn--icon btn--sm"
                          title="Forget this row"
                          aria-label="Forget this row"
                          onClick={() => onForget(event.id)}
                        >
                          <TrashIcon width="14" height="14" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
