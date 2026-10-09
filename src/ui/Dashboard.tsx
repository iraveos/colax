import { useMemo } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findWeakItems, hostnameOf, relativeTime, staleDaysFor, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import type { Channel, Tag } from '../vault/channels.ts';
import type { VaultPreferences } from '../vault/storage.ts';
import { labelOf } from './views.tsx';

/**
 * Command Center: the vault at a glance.
 *
 * One compact header, a security summary with a single primary action, four
 * metric cards, a prioritized attention list, recent activity, and condensed
 * insights (strength distribution plus a 30-day timeline). Everything counts
 * real vault data, and every number navigates somewhere that shows the logins
 * behind it.
 *
 * Configuration lives elsewhere on purpose: tag editing in the Channels
 * settings tab, reminder windows in Security. The dashboard keeps summaries
 * and shortcuts to those places, never the controls themselves.
 *
 * Motion stays minimal — stat tiles stagger in, nothing else moves — so the
 * screen reads as an instrument, not a demo.
 */

const DAY = 86_400_000;

/** One problem worth naming, in the order a user should act on it. */
type Issue = {
  key: string;
  label: string;
  count: number;
  severity: 'high' | 'medium' | 'low';
  channel: string;
  detail: string;
};

export function Dashboard({
  channels,
  tags,
  items,
  prefs,
  usage,
  onSelectChannel,
  onOpenLogin,
  onOpenSettings,
  onAddLogin,
}: {
  channels: Channel[];
  tags: Tag[];
  items: VaultItem[];
  prefs: VaultPreferences;
  /** Per-login copy/edit counts plus last-use timestamps. Drives Recent. */
  usage?: Record<string, { count: number; at: number }>;
  onSelectChannel: (channelId: string) => void;
  /** Opens one login in the editor (gated like everywhere else). */
  onOpenLogin: (item: VaultItem) => void;
  /** Jumps to a settings tab for management (tags, reminder windows). */
  onOpenSettings: (tab: string) => void;
  /** Starts a new login. Shown only when the vault is empty. */
  onAddLogin: () => void;
}) {
  const health = useMemo(() => {
    const now = Date.now();
    // Deliberately the same source the "Weak or reused" channel filters on.
    // Counting strength alone here made the dashboard report zero weak logins
    // while the sidebar it links to reported four, because reuse was missing.
    const weak = findWeakItems(items, prefs.passwordAgeDays);
    const stale = items.filter((item) => {
      if (item.password === '') return false;
      const threshold = staleDaysFor(item, prefs.passwordAgeDays);
      return threshold > 0 && now - item.passwordUpdatedAt > threshold * DAY;
    });
    const emailCheck =
      prefs.emailCheckDays > 0
        ? items.filter((item) => item.username !== '' && now - item.usernameUpdatedAt > prefs.emailCheckDays * DAY)
        : [];
    return {
      total: items.length,
      favorites: items.filter((item) => item.favorite).length,
      flagged: items.filter((item) => item.needsAttention).length,
      weak,
      stale,
      emailCheck,
      untagged: items.filter((item) => item.tags.length === 0),
      // Either kind of second factor counts: the legacy TOTP field and the
      // security block. Counting only the field under-reported every login
      // secured since passcodes existed.
      withTotp: items.filter((item) => Boolean(item.totpSecret) || isSecured(item.security)),
    };
  }, [items, prefs.passwordAgeDays, prefs.emailCheckDays]);

  const idOf = (kind: Channel['kind']) =>
    channels.find((channel) => channel.kind === kind)?.id ?? 'all';

  /** How the vault's passwords are distributed across the five strength bands. */
  const strengthBands = useMemo(() => {
    const bands: number[] = [0, 0, 0, 0, 0];
    let withPassword = 0;
    for (const item of items) {
      if (!item.password) continue;
      withPassword += 1;
      // Clamped because estimateStrength scores 0..4, but a future scorer must
      // not be able to write past the end of the band list.
      const band = Math.min(bands.length - 1, Math.max(0, estimateStrength(item.password).score));
      bands[band] = (bands[band] ?? 0) + 1;
    }
    return { bands, withPassword };
  }, [items]);

  /** Logins grouped per strength band, for the strength popover. */
  const strengthGroups = useMemo(() => {
    const groups: VaultItem[][] = [[], [], [], [], []];
    for (const item of items) {
      if (!item.password) continue;
      const band = Math.min(4, Math.max(0, estimateStrength(item.password).score));
      groups[band]!.push(item);
    }
    return groups;
  }, [items]);

  /** Logins added or changed per day for the last 30 days, oldest first. */
  const activity = useMemo(() => {
    const days: { label: string; added: number; changed: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - 29 * DAY;
    for (let index = 0; index < 30; index += 1) {
      const dayStart = start + index * DAY;
      const dayEnd = dayStart + DAY;
      const onDay = items.filter((item) => item.createdAt >= dayStart && item.createdAt < dayEnd);
      const changed = items.filter((item) => item.updatedAt >= dayStart && item.updatedAt < dayEnd).length;
      days.push({
        label: new Date(dayStart).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        added: onDay.length,
        // A login counts as changed, not added, if it was first created earlier.
        changed: Math.max(0, changed - onDay.length),
      });
    }
    return days;
  }, [items]);
  const activeDays = useMemo(
    () => activity.filter((day) => day.added + day.changed > 0),
    [activity],
  );

  /**
   * Recent account activity: real copy/edit recency first, then the most
   * recently touched logins to fill. Deleted logins are skipped, never
   * rendered as dead rows.
   */
  const recentLogins = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const out: { item: VaultItem; at: number; uses: number }[] = [];
    for (const [id, stat] of Object.entries(usage ?? {}).sort((a, b) => b[1].at - a[1].at)) {
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      out.push({ item, at: stat.at, uses: stat.count });
      if (out.length >= 5) break;
    }
    if (out.length < 5) {
      for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({ item, at: item.updatedAt, uses: 0 });
        if (out.length >= 5) break;
      }
    }
    return out;
  }, [items, usage]);

  /** Everything wrong, ranked. Only applicable issues are listed. */
  const issues = useMemo<Issue[]>(() => {
    const list: Issue[] = [];
    if (health.weak.length > 0) {
      list.push({
        key: 'weak',
        label: 'Weak or reused passwords',
        count: health.weak.length,
        severity: 'high',
        channel: idOf('weak'),
        detail: 'Short, guessable, or the same password used twice',
      });
    }
    if (health.stale.length > 0) {
      list.push({
        key: 'stale',
        label: 'Rotation overdue',
        count: health.stale.length,
        severity: 'high',
        channel: idOf('weak'),
        detail: `Unchanged past the reminder window${prefs.passwordAgeDays > 0 ? ` (${prefs.passwordAgeDays} days, per-login overrides apply)` : ''}`,
      });
    }
    if (health.emailCheck.length > 0) {
      list.push({
        key: 'email',
        label: 'Email review due',
        count: health.emailCheck.length,
        severity: 'medium',
        channel: idOf('all'),
        detail: `Addresses untouched past the check window (${prefs.emailCheckDays} days)`,
      });
    }
    if (health.flagged > 0) {
      list.push({
        key: 'flagged',
        label: 'Flagged by you',
        count: health.flagged,
        severity: 'medium',
        channel: idOf('attention'),
        detail: 'You marked these as needing attention',
      });
    }
    if (health.untagged.length > 0) {
      list.push({
        key: 'untagged',
        label: 'Untagged logins',
        count: health.untagged.length,
        severity: 'low',
        channel: 'unassigned',
        detail: 'Nothing to search them by later',
      });
    }
    const weight = { high: 0, medium: 1, low: 2 };
    return list.sort((a, b) => weight[a.severity] - weight[b.severity] || b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, prefs.passwordAgeDays, prefs.emailCheckDays, channels]);

  const headline = issues[0];
  const empty = health.total === 0;

  const metrics = [
    { label: 'Total Logins', value: health.total, channel: idOf('all') },
    { label: 'Favorites', value: health.favorites, channel: idOf('favorites') },
    { label: 'Weak Passwords', value: health.weak.length, channel: idOf('weak') },
    { label: 'Untagged Logins', value: health.untagged.length, channel: 'unassigned' },
  ];

  return (
    <div className="dashboard">
      {/* Compact header: title, one-line subtitle, vault status. */}
      <header className="cc-head">
        <div>
          <p className="cc-eyebrow">Vault overview</p>
          <h1 className="cc-title">Command Center</h1>
          <p className="cc-sub">
            {empty
              ? 'Your vault is empty — add a login to get started.'
              : `${health.total} login${health.total === 1 ? '' : 's'} at a glance.`}
          </p>
        </div>
        <span className="cc-status" role="status">
          <span className="cc-status__dot" aria-hidden="true" />
          Unlocked
        </span>
      </header>

      {/* Security summary: the count that matters and the one action that fixes
          it. Adapts instead of alarming when there is nothing to fix. */}
      {!empty ? (
        <section className="cc-security" aria-label="Security summary">
          {headline ? (
            <>
              <div className="cc-security__body">
                <span className="cc-security__count" data-severity={headline.severity}>
                  {headline.count}
                </span>
                <span>
                  <span className="cc-security__label">{headline.label}</span>
                  <span className="cc-security__detail">{headline.detail}</span>
                </span>
              </div>
              <button
                type="button"
                className="btn btn--champagne"
                onClick={() => onSelectChannel(headline.channel)}
              >
                Review now
              </button>
            </>
          ) : (
            <p className="cc-security__calm">Everything looks healthy. Nothing needs rotation or review.</p>
          )}
        </section>
      ) : null}

      {/* Four metrics. Each one navigates to the view behind its number. */}
      <div className="stat-row" role="list" aria-label="Vault metrics">
        {metrics.map((metric, index) => (
          <button
            type="button"
            role="listitem"
            className="stat stat--link"
            key={metric.label}
            style={{ animationDelay: `${index * 28}ms` } as React.CSSProperties}
            onClick={() => onSelectChannel(metric.channel)}
            title={`Show ${metric.label.toLowerCase()}`}
          >
            <span className="stat__value">{metric.value}</span>
            <span className="stat__label">{metric.label}</span>
          </button>
        ))}
      </div>

      {empty ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Get started</h2>
              <p className="dash-section__hint">Your first login is encrypted on this device straight away.</p>
            </div>
            <button type="button" className="btn btn--champagne" onClick={onAddLogin}>
              Add a login
            </button>
          </header>
        </section>
      ) : null}

      {/* Prioritized attention list. Only applicable issues render, worst
          first; each row opens the view holding those logins. */}
      {issues.length > 0 ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Needs your attention</h2>
              <p className="dash-section__hint">Worst first. Each row opens the matching view.</p>
            </div>
          </header>
          <div className="dash-issues">
            {issues.map((issue) => (
              <button className="dash-issue" key={issue.key} data-severity={issue.severity} onClick={() => onSelectChannel(issue.channel)}>
                <span className="dash-issue__bar" aria-hidden="true" />
                <span className="dash-issue__body">
                  <span className="dash-issue__label">{issue.label}</span>
                  <span className="dash-issue__detail">{issue.detail}</span>
                </span>
                <span className="dash-issue__count">{issue.count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Recent activity: real usage first, nothing invented. */}
      {!empty ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Recent Logins</h2>
              <p className="dash-section__hint">What you have actually touched lately.</p>
            </div>
          </header>
          {recentLogins.length === 0 ? (
            <p className="dash-card__empty">No activity yet — copy or edit a login and it appears here.</p>
          ) : (
            <div className="dash-list">
              {recentLogins.map(({ item, at, uses }) => (
                <div className="dash-row" key={item.id}>
                  <button
                    className="dash-row__name"
                    onClick={() => onOpenLogin(item)}
                    title={`Edit ${labelOf(item)}`}
                  >
                    {labelOf(item)}
                  </button>
                  <span className="dash-row__meta">
                    {item.username || hostnameOf(item.url) || ''}
                    {uses > 0 ? ` · ${uses} use${uses === 1 ? '' : 's'}` : ''}
                  </span>
                  <span className="dash-row__count">{relativeTime(at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* Condensed insights: strength distribution and the 30-day timeline.
          Redundant cards (domains, most-used, reuse clusters) are gone — the
          attention list and the weak channel already answer those questions. */}
      {!empty && strengthBands.withPassword > 0 ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Insights</h2>
              <p className="dash-section__hint">How guessable passwords are, and what changed lately.</p>
            </div>
          </header>
          <div className="dash-insights dash-insights--duo">
            <article className="dash-card" tabIndex={0}>
              <h3 className="dash-card__title">Password strength</h3>
              <div className="dash-strength" role="img" aria-label={`Password strength across ${strengthBands.withPassword} logins`}>
                {strengthBands.bands.map((count, index) =>
                  count > 0 ? (
                    <span key={index} style={{ flexGrow: count }} data-band={index} title={`Band ${index + 1}: ${count}`} />
                  ) : null,
                )}
              </div>
              <ul className="dash-key">
                {['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'].map((label, index) => (
                  <li key={label} data-band={index}>
                    <span className="dash-key__dot" />
                    {label}
                    <b>{strengthBands.bands[index] ?? 0}</b>
                  </li>
                ))}
              </ul>
              <div className="dash-pop" role="dialog" aria-label="Password strength breakdown">
                <p className="dash-pop__about">
                  What this is: how guessable each saved password is, from very weak to excellent. Weak logins
                  also appear in the “Weak or reused” channel — open one to fix it.
                </p>
                <div className="dash-pop__scroll">
                  {['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'].map((label, index) => (
                    <div className="dash-pop__group" key={label}>
                      <span className="dash-pop__group-title" data-band={index}>
                        {label} · {strengthBands.bands[index] ?? 0}
                      </span>
                      {(strengthGroups[index] ?? []).length === 0 ? (
                        <span className="dash-pop__muted">None</span>
                      ) : (
                        (strengthGroups[index] ?? []).map((item) => (
                          <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                            <span className="dash-pop__name">{labelOf(item)}</span>
                            <span className="dash-pop__meta">{item.username || hostnameOf(item.url) || ''}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </article>

            <article className="dash-card" tabIndex={0}>
              <h3 className="dash-card__title">Last 30 days</h3>
              {activeDays.length === 0 ? (
                <p className="dash-card__empty">Nothing added or changed in the last 30 days.</p>
              ) : (
                <>
                  <div className="dash-spark" role="img" aria-label="Logins added or changed over the last 30 days">
                    {activity.map((day, index) => {
                      const total = day.added + day.changed;
                      return (
                        <span key={index} className="dash-spark__col" title={`${day.label}: ${day.added} added, ${day.changed} changed`}>
                          <span className="dash-spark__bar" data-empty={total === 0 || undefined} style={{ height: `${Math.min(100, total * 18 + (total ? 8 : 0))}%` }} />
                        </span>
                      );
                    })}
                  </div>
                  <p className="dash-card__foot">
                    {activity.reduce((sum, day) => sum + day.added, 0)} added ·{' '}
                    {activity.reduce((sum, day) => sum + day.changed, 0)} changed
                  </p>
                </>
              )}
            </article>
          </div>
        </section>
      ) : null}

      {/* Email review stays a slim list: it is the only direct route to these
          logins, and the attention row above points here in spirit. */}
      {health.emailCheck.length > 0 ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Email review</h2>
              <p className="dash-section__hint">Addresses untouched past the check window. Open one to update it.</p>
            </div>
          </header>
          <div className="dash-list">
            {health.emailCheck.slice(0, 8).map((item) => (
              <div className="dash-row" key={item.id}>
                <button className="dash-row__name" onClick={() => onOpenLogin(item)} title={`Edit ${item.title || item.username || 'login'}`}>
                  {item.title || item.username || hostnameOf(item.url) || 'Untitled'}
                </button>
                <span className="dash-row__meta">{item.username}</span>
              </div>
            ))}
          </div>
          {health.emailCheck.length > 8 ? (
            <p className="dash-card__empty">+{health.emailCheck.length - 8} more in the vault.</p>
          ) : null}
        </section>
      ) : null}

      {/* Summaries with shortcuts. Tag/channel editing and reminder windows
          live in Settings — this stays a signpost, not a second copy. */}
      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Organize</h2>
            <p className="dash-section__hint">Structure at a glance. Editing happens in Settings.</p>
          </div>
        </header>
        <div className="dash-list">
          <div className="dash-row">
            <span className="dash-row__name">{tags.length} tag{tags.length === 1 ? '' : 's'}</span>
            <span className="dash-row__meta">Rename, recolour, delete</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpenSettings('channels')}>
              Manage tags
            </button>
          </div>
          <div className="dash-row">
            <span className="dash-row__name">{channels.length} channel{channels.length === 1 ? '' : 's'}</span>
            <span className="dash-row__meta">Create, edit, reorder</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpenSettings('channels')}>
              Manage channels
            </button>
          </div>
          <div className="dash-row">
            <span className="dash-row__name">Reminder windows</span>
            <span className="dash-row__meta">Rotation, email checks, stale flags</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpenSettings('security')}>
              Open Security
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
