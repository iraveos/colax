import { useMemo } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findWeakItems, hostnameOf, relativeTime, staleDaysFor, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import { applyChannel, type Channel, type Tag } from '../vault/channels.ts';
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
  onNewChannel,
  onBulkAdd,
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
  /** Opens a blank channel editor. */
  onNewChannel: () => void;
  /** Opens the bulk-add dialog. */
  onBulkAdd: () => void;
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

  /**
   * Actual reuse clusters, not just a count.
   *
   * Knowing a password is shared is less useful than knowing which logins
   * share it, because that is the set you have to fix together.
   */
  const reuseClusters = useMemo(() => {
    const byPassword = new Map<string, VaultItem[]>();
    for (const item of items) {
      if (!item.password) continue;
      const group = byPassword.get(item.password);
      if (group) group.push(item);
      else byPassword.set(item.password, [item]);
    }
    return [...byPassword.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.slice().sort((a, b) => a.title.localeCompare(b.title)))
      .sort((a, b) => b.length - a.length);
  }, [items]);

  /** The sites carrying the most logins, for spotting where risk is pooled. */
  const allDomains = useMemo(() => {
    const byHost = new Map<string, { count: number; logins: VaultItem[] }>();
    for (const item of items) {
      const host = hostnameOf(item.url);
      if (!host) continue;
      // Collapse subdomains so login.example.com and example.com are one row.
      const parts = host.split('.');
      const registrable = parts.length > 2 ? parts.slice(-2).join('.') : host;
      const entry = byHost.get(registrable);
      if (entry) {
        entry.count += 1;
        entry.logins.push(item);
      } else {
        byHost.set(registrable, { count: 1, logins: [item] });
      }
    }
    return [...byHost.entries()]
      .map(([host, value]) => ({ host, count: value.count, logins: value.logins }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  }, [items]);
  const topDomains = useMemo(() => allDomains.slice(0, 8), [allDomains]);

  /**
   * Most-used logins by copy/edit count, top 5 shown and scrollable to 20.
   * Count first, recency second, so a login used fifty times last year still
   * outranks one used twice today. Deleted logins are skipped, never rendered
   * as dead rows.
   */
  const mostUsed = useMemo(() => {
    const source = usage ?? {};
    const byId = new Map(items.map((item) => [item.id, item]));
    return Object.entries(source)
      .sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
      .map(([id]) => ({ item: byId.get(id), stat: source[id]! }))
      .filter((entry): entry is { item: VaultItem; stat: { count: number; at: number } } => Boolean(entry.item))
      .slice(0, 20);
  }, [items, usage]);

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

  /** Logins per channel, for the distribution bars. Biggest first. */
  const perChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const channel of channels) {
      try {
        counts.set(channel.id, applyChannel(channel, items, prefs.passwordAgeDays).length);
      } catch {
        counts.set(channel.id, 0);
      }
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ channel: channels.find((entry) => entry.id === id)!, count }))
      .filter((entry) => entry.channel)
      .sort((a, b) => b.count - a.count || a.channel.name.localeCompare(b.channel.name));
  }, [channels, items, prefs.passwordAgeDays]);

  /** Share of the vault with nothing serious wrong with it. */
  const covered =
    health.total === 0
      ? 0
      : Math.max(
          0,
          Math.round(
            ((health.total -
              issues.filter((issue) => issue.severity !== 'low').reduce((sum, issue) => sum + issue.count, 0)) /
              health.total) *
              100,
          ),
        );

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
          <div className="cc-security__main">
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
          </div>
          <div className="cc-security__foot">
            <div className="dash-coverage" role="img" aria-label={`${covered}% of the vault in good shape`}>
              <span style={{ width: `${covered}%` }} />
            </div>
            <span className="cc-security__cover">{covered}% in good shape</span>
          </div>
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

      {/* Attention beside recent: the two lists you act on, side by side on a
          PC screen, stacked on narrow ones. */}
      {!empty && (issues.length > 0 || recentLogins.length > 0) ? (
        <div className="dash-grid">
          <div className="dash-grid__main">
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
          </div>
          <div className="dash-grid__side">
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
          </div>
        </div>
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
          <div className="dash-insights">
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

            <article className="dash-card" tabIndex={0}>
              <h3 className="dash-card__title">Most logins per site</h3>
              {topDomains.length === 0 ? (
                <p className="dash-card__empty">No websites saved yet.</p>
              ) : (
                <ul className="dash-bars">
                  {topDomains.map((entry) => (
                    <li key={entry.host}>
                      <span className="dash-bars__label">{entry.host}</span>
                      <span className="dash-bars__track">
                        <span className="dash-bars__fill" style={{ width: `${(entry.count / topDomains[0]!.count) * 100}%` }} />
                      </span>
                      <b>{entry.count}</b>
                    </li>
                  ))}
                </ul>
              )}
              <div className="dash-pop" role="dialog" aria-label="Sites with the most logins">
                <p className="dash-pop__about">
                  What this is: where your logins cluster. The site with the most logins is where one
                  breach hurts most — hover to see every site, click a login to open it.
                </p>
                <div className="dash-pop__scroll">
                  {allDomains.length === 0 ? (
                    <span className="dash-pop__muted">No websites saved yet.</span>
                  ) : (
                    allDomains.map((entry) => (
                      <div className="dash-pop__group" key={entry.host}>
                        <span className="dash-pop__group-title">
                          {entry.host} · {entry.count}
                        </span>
                        {entry.logins.map((item) => (
                          <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                            <span className="dash-pop__name">{labelOf(item)}</span>
                            <span className="dash-pop__meta">{item.username}</span>
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </article>

            {/* Reuse clusters. The actionable one: each row is one password and
                every login that shares it. */}
            <article className="dash-card" tabIndex={0}>
              <h3 className="dash-card__title">Reused passwords</h3>
              {reuseClusters.length === 0 ? (
                <p className="dash-card__empty">
                  {strengthBands.withPassword === 0 ? 'No passwords stored yet.' : 'Nothing is reused. Good.'}
                </p>
              ) : (
                <ul className="dash-reuse">
                  {reuseClusters.slice(0, 5).map((group, index) => (
                    <li key={index}>
                      <span className="dash-reuse__count">{group.length}&times;</span>
                      <span className="dash-reuse__sites">
                        {group.map((item) => item.title || item.username || hostnameOf(item.url) || 'Untitled').join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="dash-pop" role="dialog" aria-label="Reused passwords breakdown">
                <p className="dash-pop__about">
                  What this is: every password used more than once, and the logins sharing it. Fix one
                  group at a time — each row below opens its login. These logins also sit in the
                  “Weak or reused” channel.
                </p>
                <div className="dash-pop__scroll">
                  {reuseClusters.length === 0 ? (
                    <span className="dash-pop__muted">Nothing is reused. Good.</span>
                  ) : (
                    reuseClusters.map((group, index) => (
                      <div className="dash-pop__group" key={index}>
                        <span className="dash-pop__group-title dash-pop__group-title--danger">
                          Shared by {group.length}
                        </span>
                        {group.map((item) => (
                          <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                            <span className="dash-pop__name">{labelOf(item)}</span>
                            <span className="dash-pop__meta">{item.username || hostnameOf(item.url) || ''}</span>
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </article>

            {/* Most used: top 5 by copy/edit count, hover for a big scrollable menu to 20. */}
            <article className="dash-card" tabIndex={0}>
              <h3 className="dash-card__title">Most used</h3>
              {mostUsed.length === 0 ? (
                <p className="dash-card__empty">Copy or edit a login and it climbs here.</p>
              ) : (
                <ul className="dash-reuse">
                  {mostUsed.slice(0, 5).map(({ item, stat }) => (
                    <li key={item.id}>
                      <button type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)} — used ${stat.count} time${stat.count === 1 ? '' : 's'}`}>
                        <span className="dash-reuse__count">{stat.count}&times;</span>
                        <span className="dash-reuse__sites">{labelOf(item)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {mostUsed.length > 0 ? (
                <p className="dash-card__foot">
                  Top {Math.min(5, mostUsed.length)} of {mostUsed.length} · hover for all {mostUsed.length}
                </p>
              ) : null}
              <div className="dash-pop dash-pop--wide" role="dialog" aria-label="Most used logins">
                <p className="dash-pop__about">
                  What this is: the logins you copy or edit most. Count first, recency second — hovering
                  shows the top 5 above, this menu scrolls to 20. Click one to open it.
                </p>
                <div className="dash-pop__scroll">
                  {mostUsed.length === 0 ? (
                    <span className="dash-pop__muted">Nothing used yet. Copy a password and it appears here.</span>
                  ) : (
                    mostUsed.map(({ item, stat }, index) => (
                      <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                        <span className="dash-pop__rank">{index + 1}</span>
                        <span className="dash-pop__name">{labelOf(item)}</span>
                        <span className="dash-pop__meta">
                          {stat.count} use{stat.count === 1 ? '' : 's'}
                          {item.username ? ` · ${item.username}` : ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </article>
          </div>
        </section>
      ) : null}

      {/* Review lists side by side on wide screens: the only direct routes to
          these logins. Email review keeps its slim list; second factors get
          theirs back — every login carrying its own factor, open one to
          change it. */}
      {health.emailCheck.length > 0 || health.withTotp.length > 0 ? (
        <div className="dash-grid">
          {health.emailCheck.length > 0 ? (
            <section className="dash-section dash-grid__main">
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
          {health.withTotp.length > 0 ? (
            <section className="dash-section dash-grid__side">
              <header className="dash-section__head">
                <div>
                  <h2 className="dash-section__title">Second factors</h2>
                  <p className="dash-section__hint">Every login carrying its own factor. Open one to change it.</p>
                </div>
              </header>
              <div className="dash-list">
                {health.withTotp.slice(0, 8).map((item) => (
                  <div className="dash-row" key={item.id}>
                    <button className="dash-row__name" onClick={() => onOpenLogin(item)} title={`Edit ${item.title || item.username || 'login'}`}>
                      {item.title || item.username || hostnameOf(item.url) || 'Untitled'}
                    </button>
                    <span className="dash-row__meta">{item.username}</span>
                  </div>
                ))}
              </div>
              {health.withTotp.length > 8 ? (
                <p className="dash-card__empty">+{health.withTotp.length - 8} more in the vault.</p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {/* Distribution beside quick actions: where logins live, and the three
          ways to make more of them. */}
      {!empty ? (
        <div className="dash-grid">
          <section className="dash-section dash-grid__main">
            <header className="dash-section__head">
              <div>
                <h2 className="dash-section__title">Channels</h2>
                <p className="dash-section__hint">Where your logins live. Open one.</p>
              </div>
            </header>
            {perChannel.length === 0 ? (
              <p className="dash-card__empty">No channels yet.</p>
            ) : (
              <>
                <ul className="dash-bars">
                  {perChannel.slice(0, 8).map(({ channel, count }) => (
                    <li key={channel.id}>
                      <button
                        type="button"
                        className="dash-bars__label dash-bars__link"
                        onClick={() => onSelectChannel(channel.id)}
                        title={`Show ${channel.name}`}
                      >
                        {channel.name}
                      </button>
                      <span className="dash-bars__track">
                        <span
                          className="dash-bars__fill"
                          style={{ width: `${(count / Math.max(1, perChannel[0]!.count)) * 100}%` }}
                        />
                      </span>
                      <b>{count}</b>
                    </li>
                  ))}
                </ul>
                {perChannel.length > 8 ? (
                  <p className="dash-card__empty">+{perChannel.length - 8} more in the sidebar.</p>
                ) : null}
              </>
            )}
          </section>
          <div className="dash-grid__side">
            <section className="dash-section">
              <header className="dash-section__head">
                <div>
                  <h2 className="dash-section__title">Quick actions</h2>
                  <p className="dash-section__hint">Create without leaving.</p>
                </div>
              </header>
              <div className="dash-actions">
                <button type="button" className="btn btn--champagne" onClick={onAddLogin}>
                  New login
                </button>
                <button type="button" className="btn btn--secondary" onClick={onBulkAdd}>
                  Bulk add logins
                </button>
                <button type="button" className="btn btn--secondary" onClick={onNewChannel}>
                  New channel
                </button>
              </div>
            </section>
          </div>
        </div>
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
