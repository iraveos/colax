import { useMemo, useState } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findWeakItems, hostnameOf, staleDaysFor, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import { applyChannel, CHANNEL_KIND_LABELS, createTag, DEFAULT_TAG_SEEDS, ensureDefaultTags, type Channel, type Tag } from '../vault/channels.ts';
import type { VaultPreferences } from '../vault/storage.ts';
import { labelOf } from './views.tsx';

/**
 * The vault at a glance.
 *
 * Rebuilt around one idea: the first screen should answer "is anything wrong,
 * and what do I do about it" without the user reading a number for each metric.
 * So the health figures are ranked and the top problem is stated in a sentence,
 * everything else is supporting detail, and the configuration that governs those
 * thresholds sits directly under the numbers it changes.
 *
 * Two motion ideas only, both from the vendored list already in the project: the
 * stat tiles stagger in, and the health bar animates its fill. Adding more
 * animation on top of a dense screen costs legibility, not personality.
 */

const DAY = 86_400_000;

/** One problem worth naming, in the order a user should act on it. */
type Issue = {
  key: string;
  label: string;
  /** What follows the count in the hero, e.g. "logins have a stale password". */
  heroText: string;
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
  onEditChannel,
  onNewChannel,
  onSelectChannel,
  onOpenLogin,
  onTagsChange,
  onScrubTag,
  onUpdate,
  onNotify,
}: {
  channels: Channel[];
  tags: Tag[];
  items: VaultItem[];
  prefs: VaultPreferences;
  /** Per-login copy/edit counts. Drives the "Most used" insight card. */
  usage?: Record<string, { count: number; at: number }>;
  onEditChannel: (channelId: string) => void;
  onNewChannel: () => void;
  onSelectChannel: (channelId: string) => void;
  /** Opens one login in the editor (gated like everywhere else). */
  onOpenLogin: (item: VaultItem) => void;
  onTagsChange: (next: Tag[]) => void;
  onScrubTag: (tagId: string) => void;
  onUpdate: (patch: Partial<VaultPreferences>) => void;
  onNotify: (message: string, tone?: import('./hooks.ts').Toast['tone']) => void;
}) {
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const set = (patch: Partial<typeof prefs>) => onUpdate(patch);

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
    const staleEmail =
      prefs.emailAgeDays > 0
        ? items.filter((item) => item.username !== '' && now - item.usernameUpdatedAt > prefs.emailAgeDays * DAY)
        : [];
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
      staleEmail,
      emailCheck,
      untagged: items.filter((item) => item.tags.length === 0),
      // Either kind of second factor counts: the legacy TOTP field and the
      // security block. Counting only the field under-reported every login
      // secured since passcodes existed.
      withTotp: items.filter((item) => Boolean(item.totpSecret) || isSecured(item.security)),
    };
  }, [items, prefs.passwordAgeDays, prefs.emailAgeDays, prefs.emailCheckDays]);

  const perTag = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) for (const tagId of item.tags) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    return counts;
  }, [items]);

  const perChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const channel of channels) {
      counts.set(channel.id, applyChannel(channel, items, prefs.passwordAgeDays).length);
    }
    return counts;
  }, [channels, items, prefs.passwordAgeDays]);

  const sortedTags = useMemo(() => {
    const list = [...tags];
    if (prefs.tagSort === 'count') {
      list.sort((a, b) => (perTag.get(b.id) ?? 0) - (perTag.get(a.id) ?? 0) || a.name.localeCompare(b.name));
    } else if (prefs.tagSort === 'hue') {
      list.sort((a, b) => a.hue - b.hue);
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }, [tags, prefs.tagSort, perTag]);

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

  /**
   * Actual reuse clusters, not just a count.
   *
   * Knowing a password is shared is less useful than knowing which four logins
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

  /** Everything wrong, ranked. The first entry becomes the headline. */
  const issues = useMemo<Issue[]>(() => {
    const list: Issue[] = [];
    if (health.stale.length > 0) {
      list.push({
        key: 'stale',
        label: 'Password unchanged',
        heroText: 'have an unchanged password',
        count: health.stale.length,
        severity: 'high',
        channel: idOf('weak'),
        detail: `Older than ${prefs.passwordAgeDays} days`,
      });
    }
    if (health.weak.length > 0) {
      list.push({
        key: 'weak',
        label: 'Weak or reused',
        heroText: 'are weak or reused',
        count: health.weak.length,
        severity: 'high',
        channel: idOf('weak'),
        detail: 'Short, or the same password used twice',
      });
    }
    if (health.flagged > 0) {
      list.push({
        key: 'flagged',
        label: 'Flagged by you',
        heroText: 'are flagged for attention',
        count: health.flagged,
        severity: 'high',
        channel: idOf('attention'),
        detail: 'You marked these as needing attention',
      });
    }
    if (health.staleEmail.length > 0) {
      list.push({
        key: 'staleEmail',
        label: 'Email unchanged',
        heroText: 'have an unchanged email',
        count: health.staleEmail.length,
        severity: 'medium',
        channel: idOf('all'),
        detail: `Older than ${prefs.emailAgeDays} days`,
      });
    }
    if (health.untagged.length > 0) {
      list.push({
        key: 'untagged',
        label: 'No tags',
        heroText: 'have no tags yet',
        count: health.untagged.length,
        severity: 'low',
        channel: idOf('all'),
        detail: 'Nothing to search them by later',
      });
    }
    const weight = { high: 0, medium: 1, low: 2 };
    return list.sort((a, b) => weight[a.severity] - weight[b.severity] || b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, prefs.passwordAgeDays, prefs.emailAgeDays, channels]);

  // The headline only ever names a real risk. "5 have no tags yet" is not a
  // problem, and leading the screen with it made the vault read as though
  // something were wrong when nothing was — especially next to the coverage bar
  // saying 100% was fine.
  const serious = issues.filter((issue) => issue.severity !== 'low');
  const headline = serious[0];
  const nits = issues.length - serious.length;
  const clean = issues.length === 0 && health.total > 0;
  const empty = health.total === 0;

  /**
   * Share of the vault with nothing wrong with it.
   *
   * Only high and medium issues count against it. "No tags" is a housekeeping
   * nit, not a risk, and letting it drag the bar to 0% made a perfectly healthy
   * vault read as though every login were compromised.
   */
  const atRisk = issues.filter((issue) => issue.severity !== 'low').reduce((sum, issue) => sum + issue.count, 0);
  const covered = health.total === 0 ? 0 : Math.max(0, Math.round(((health.total - atRisk) / health.total) * 100));

  function addTag() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const existing = tags.find((tag) => tag.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      onNotify(`"${existing.name}" already exists`, 'error');
      return;
    }
    onTagsChange([...tags, createTag(trimmed, tags)]);
    setNewName('');
    onNotify(`Tag "${trimmed}" created`);
  }

  function rename(tag: Tag, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tag.name) return setRenaming(null);
    onTagsChange(tags.map((entry) => (entry.id === tag.id ? { ...entry, name: trimmed } : entry)));
    setRenaming(null);
  }

  function removeTag(tag: Tag) {
    const affected = channels.filter((channel) => channel.tagIds.includes(tag.id)).length;
    const logins = perTag.get(tag.id) ?? 0;
    onTagsChange(tags.filter((entry) => entry.id !== tag.id));
    onScrubTag(tag.id);
    onNotify(
      `Deleted "${tag.name}" — ${logins} login${logins === 1 ? '' : 's'}` +
        (affected ? ` and ${affected} channel${affected === 1 ? '' : 's'}` : ''),
    );
  }

  return (
    <div className="dashboard">
      {/* Hero. One sentence about the state of the vault, and the single action
          that most improves it. This replaces seven equal-weight numbers as the
          thing the eye lands on first. */}
      <header className="dash-hero">
        <div className="dash-hero__text">
          <p className="dash-hero__eyebrow">
            {empty ? 'Nothing stored yet' : `${health.total} login${health.total === 1 ? '' : 's'}`}
          </p>
          <h1 className="dash-hero__title">
            {empty ? (
              'Add your first login'
            ) : !headline ? (
              'Everything looks healthy'
            ) : (
              <>
                <span className="dash-hero__count">{headline.count}</span>
                {/* Phrase that follows the count, so the sentence reads as
                    "3 logins have an unchanged password" rather than the bare
                    label. */}
                <span className="dash-hero__what">{headline.heroText}</span>
              </>
            )}
          </h1>
          <p className="dash-hero__hint">
            {empty
              ? 'Create one, or let Colax offer it to you when you sign up somewhere in your browser.'
              : !headline
                ? clean
                  ? 'No weak, reused or long-untouched passwords. That is unusual — worth double-checking.'
                  : `Nothing risky. ${nits > 0 ? `Only untagged logins to tidy up.` : ''} ${covered}% of the vault is in good shape.`
                : `${headline.detail}. ${covered}% of the vault is in good shape.`}
          </p>
        </div>

        {headline ? (
          <button className="dash-hero__action" onClick={() => onSelectChannel(headline.channel)}>
            Review {headline.count}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 12h13M12 5l7 7-7 7" />
            </svg>
          </button>
        ) : null}
      </header>

      {/* Coverage bar. Animated because the number moves as you act on it, and
          a bar that jumps does not read as progress. Green only when there is
          genuinely nothing to fix, not merely nothing urgent. */}
      <div className="dash-bar" data-clean={!headline && !empty || undefined}>
        <div className="dash-bar__fill" style={{ width: `${empty ? 100 : covered}%` }} />
      </div>

{/* Secondary figures, staggered in. Every tile that has a channel behind
          it is a button: the whole point of a number on this screen is that
          clicking it takes you to the logins it counts. A tile reading zero is
          still worth clicking — that is exactly when you want to confirm the
          view really is empty rather than mis-filtered. Tiles with no matching
          channel stay as plain figures rather than pretending to link. */}
      <div className="stat-row">
        {[
          { label: 'Favorites', value: health.favorites, target: 'favorites' },
          { label: 'Flagged', value: health.flagged, target: 'attention' },
          { label: 'Weak', value: health.weak.length, target: 'weak' },
          // Stale passwords are a subset of the Weak channel, so the tile
          // jumps there rather than pretending a stale-only view exists.
          { label: 'Stale', value: health.stale.length, target: 'weak' },
          { label: 'Email due', value: health.emailCheck.length, target: 'email' },
          { label: 'Untagged', value: health.untagged.length, target: 'unassigned' },
          { label: 'With 2FA', value: health.withTotp.length, target: 'factors' },
        ].map((stat, index) => {
          // Resolve by kind so a rebuilt or renamed channel still matches.
          const channelId =
            stat.target === 'unassigned'
              ? 'unassigned'
              : stat.target === 'email' || stat.target === 'factors'
                ? null
                : idOf(stat.target as Channel['kind']);
          const body = (
            <>
              <span className="stat__value">{stat.value}</span>
              <span className="stat__label">{stat.label}</span>
            </>
          );
          const style = { animationDelay: `${index * 28}ms` } as React.CSSProperties;
          const go = channelId
            ? () => onSelectChannel(channelId)
            : stat.target === 'email' || stat.target === 'factors'
              ? () => document.getElementById(`dash-review-${stat.target}`)?.scrollIntoView({ block: 'start' })
              : null;
          return go ? (
            <button
              type="button"
              className="stat stat--link"
              key={stat.label}
              style={style}
              onClick={go}
              title={`Show ${stat.label.toLowerCase()}`}
            >
              {body}
            </button>
          ) : (
            <div className="stat" key={stat.label} style={style}>
              {body}
            </div>
          );
        })}
      </div>

      {/* Insights. Hover (or focus) any card for a scrollable breakdown of what
          that card means and which logins are behind it. */}
      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Insights</h2>
            <p className="dash-section__hint">
              Strength across the vault, anything reused, recent activity, where your logins cluster, and what you
              use most. Hover any card for the full scrollable breakdown.
            </p>
          </div>
        </header>

        <div className="dash-insights">
          {/* Strength: a stacked bar, because the point is the proportions
              rather than five separate numbers. */}
          <article className="dash-card" tabIndex={0}>
            <h3 className="dash-card__title">Password strength</h3>
            {strengthBands.withPassword === 0 ? (
              <p className="dash-card__empty">No passwords stored yet.</p>
            ) : (
              <>
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
              </>
            )}
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

          {/* Activity: 30 columns, one per day. */}
          <article className="dash-card" tabIndex={0}>
            <h3 className="dash-card__title">Last 30 days</h3>
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
            <div className="dash-pop" role="dialog" aria-label="Recent activity breakdown">
              <p className="dash-pop__about">
                What this is: logins added or changed per day for the last 30 days. Only days with
                something on them are listed.
              </p>
              <div className="dash-pop__scroll">
                {activity.every((day) => day.added === 0 && day.changed === 0) ? (
                  <span className="dash-pop__muted">Nothing added or changed in the last 30 days.</span>
                ) : (
                  activity.map((day, index) =>
                    day.added + day.changed > 0 ? (
                      <div className="dash-pop__row" key={index}>
                        <span className="dash-pop__name">{day.label}</span>
                        <span className="dash-pop__meta">
                          {day.added} added · {day.changed} changed
                        </span>
                      </div>
                    ) : null,
                  )
                )}
              </div>
            </div>
          </article>

          {/* Domains, as proportional bars against the largest. */}
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

      {/* Everything still outstanding, ranked. One list rather than a section
          per metric. */}
      {issues.length > 0 ? (
        <section className="dash-section">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Needs a look</h2>
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

      {/* Review lists the stat tiles scroll to. Each row opens the login in the
          editor (gated like everywhere else), so "email due" ends in an edit
          rather than a shrug. Capped at thirty rows; beyond that the count in
          the tile says how many more there are. */}
      {health.emailCheck.length > 0 ? (
        <section className="dash-section" id="dash-review-email">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Email review</h2>
              <p className="dash-section__hint">Addresses untouched past the check window. Open one to update it.</p>
            </div>
          </header>
          <div className="dash-list">
            {health.emailCheck.slice(0, 30).map((item) => (
              <div className="dash-row" key={item.id}>
                <button className="dash-row__name" onClick={() => onOpenLogin(item)} title={`Edit ${item.title || item.username || 'login'}`}>
                  {item.title || item.username || hostnameOf(item.url) || 'Untitled'}
                </button>
                <span className="dash-row__meta">{item.username}</span>
              </div>
            ))}
          </div>
          {health.emailCheck.length > 30 ? (
            <p className="dash-card__empty">+{health.emailCheck.length - 30} more in the vault.</p>
          ) : null}
        </section>
      ) : null}

      {health.withTotp.length > 0 ? (
        <section className="dash-section" id="dash-review-factors">
          <header className="dash-section__head">
            <div>
              <h2 className="dash-section__title">Second factors</h2>
              <p className="dash-section__hint">Every login carrying its own factor. Open one to change it.</p>
            </div>
          </header>
          <div className="dash-list">
            {health.withTotp.slice(0, 30).map((item) => (
              <div className="dash-row" key={item.id}>
                <button className="dash-row__name" onClick={() => onOpenLogin(item)} title={`Edit ${item.title || item.username || 'login'}`}>
                  {item.title || item.username || hostnameOf(item.url) || 'Untitled'}
                </button>
                <span className="dash-row__meta">{item.username}</span>
              </div>
            ))}
          </div>
          {health.withTotp.length > 30 ? (
            <p className="dash-card__empty">+{health.withTotp.length - 30} more in the vault.</p>
          ) : null}
        </section>
      ) : null}

      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Reminders</h2>
            <p className="dash-section__hint">
              These thresholds drive the counts above and the matching view, so they are editable in one place.
              Each reminder lists the logins behind it — open one to fix it.
            </p>
          </div>
          <button className="btn btn--secondary" onClick={() => onSelectChannel(idOf('weak'))} title="Open the Weak or reused channel">
            Open Weak or reused
          </button>
        </header>
        <div className="dash-reminders">
          <div className="dash-reminder">
            <span className="dash-reminder__label">Change password</span>
            <span className="dash-reminder__count">{health.weak.length} weak or reused · {health.flagged} flagged</span>
            <select
              className="select__trigger"
              value={String(prefs.passwordAgeDays)}
              onChange={(event) => set({ passwordAgeDays: Number(event.target.value) })}
              aria-label="Change password reminder window"
            >
              {REMINDER_DAYS.password.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
            <div className="dash-reminder__logins">
              {health.weak.length === 0 ? (
                <span className="dash-pop__muted">No weak or reused logins.</span>
              ) : (
                health.weak.slice(0, 5).map((item) => (
                  <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                    <span className="dash-pop__name">{labelOf(item)}</span>
                    <span className="dash-pop__meta">
                      {item.needsAttention ? 'needs attention · ' : ''}{item.username || hostnameOf(item.url) || ''}
                    </span>
                  </button>
                ))
              )}
              {health.weak.length > 5 ? (
                <button type="button" className="dash-pop__more" onClick={() => onSelectChannel(idOf('weak'))}>
                  +{health.weak.length - 5} more in Weak or reused
                </button>
              ) : null}
            </div>
          </div>

          <div className="dash-reminder">
            <span className="dash-reminder__label">Check email</span>
            <span className="dash-reminder__count">{health.emailCheck.length} due</span>
            <select
              className="select__trigger"
              value={String(prefs.emailCheckDays)}
              onChange={(event) => set({ emailCheckDays: Number(event.target.value) })}
              aria-label="Check email reminder window"
            >
              {REMINDER_DAYS.emailCheck.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
            <div className="dash-reminder__logins">
              {health.emailCheck.length === 0 ? (
                <span className="dash-pop__muted">Nothing due.</span>
              ) : (
                health.emailCheck.slice(0, 5).map((item) => (
                  <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                    <span className="dash-pop__name">{labelOf(item)}</span>
                    <span className="dash-pop__meta">{item.username}</span>
                  </button>
                ))
              )}
              {health.emailCheck.length > 5 ? (
                <span className="dash-pop__muted">+{health.emailCheck.length - 5} more in the vault.</span>
              ) : null}
            </div>
          </div>

          <div className="dash-reminder">
            <span className="dash-reminder__label">Stale email</span>
            <span className="dash-reminder__count">{health.staleEmail.length} flagged</span>
            <select
              className="select__trigger"
              value={String(prefs.emailAgeDays)}
              onChange={(event) => set({ emailAgeDays: Number(event.target.value) })}
              aria-label="Stale email reminder window"
            >
              {REMINDER_DAYS.emailAge.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
            <div className="dash-reminder__logins">
              {health.staleEmail.length === 0 ? (
                <span className="dash-pop__muted">Nothing stale.</span>
              ) : (
                health.staleEmail.slice(0, 5).map((item) => (
                  <button key={item.id} type="button" className="dash-pop__row" onClick={() => onOpenLogin(item)} title={`Edit ${labelOf(item)}`}>
                    <span className="dash-pop__name">{labelOf(item)}</span>
                    <span className="dash-pop__meta">{item.username}</span>
                  </button>
                ))
              )}
              {health.staleEmail.length > 5 ? (
                <span className="dash-pop__muted">+{health.staleEmail.length - 5} more in the vault.</span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Tags</h2>
            <p className="dash-section__hint">
              Rename, recolour or delete — including the weak, needs attention and reused defaults. Deleting a
              tag also removes it from every login and channel using it.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {DEFAULT_TAG_SEEDS.some((seed) => !tags.some((tag) => tag.name.toLowerCase() === seed.name.toLowerCase())) ? (
            <button
              className="btn btn--secondary"
              onClick={() => {
                const restored = ensureDefaultTags(tags);
                onTagsChange(restored);
                onNotify('Default tags restored');
              }}
              title="Re-add any missing weak / needs attention / reused tag"
            >
              Restore defaults
            </button>
          ) : null}
          <div className="segmented">
            {(['name', 'count', 'hue'] as const).map((option) => (
              <button
                key={option}
                className="segmented__option"
                aria-pressed={prefs.tagSort === option}
                onClick={() => set({ tagSort: option })}
              >
                {option === 'name' ? 'Name' : option === 'count' ? 'Used' : 'Colour'}
              </button>
            ))}
          </div>
          </div>
        </header>

        {tags.length === 0 ? (
          <p className="dash-section__hint">No tags yet. Create one below, or from a login&apos;s editor.</p>
        ) : (
          <div className="dash-list">
            {sortedTags.map((tag) => {
              const count = perTag.get(tag.id) ?? 0;
              const usedBy = channels.filter((channel) => channel.tagIds.includes(tag.id)).length;
              return (
                <div className="dash-row" key={tag.id}>
                  <span className="dash-row__dot" style={{ background: `hsl(${tag.hue} 46% 54%)` }} />
                  {renaming === tag.id ? (
                    <input
                      className="input input--mono"
                      defaultValue={tag.name}
                      autoFocus
                      onBlur={(event) => rename(tag, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') setRenaming(null);
                      }}
                      aria-label={`Rename ${tag.name}`}
                    />
                  ) : (
                    <button className="dash-row__name" onClick={() => setRenaming(tag.id)} title="Rename">
                      {tag.name}
                    </button>
                  )}
                  {DEFAULT_TAG_SEEDS.some((seed) => seed.name.toLowerCase() === tag.name.toLowerCase()) ? (
                    <span className="dash-row__badge" title="Default health tag — still fully editable">default</span>
                  ) : null}
                  <input
                    className="dash-row__hue"
                    type="range"
                    min={0}
                    max={359}
                    value={tag.hue}
                    onChange={(event) =>
                      onTagsChange(
                        tags.map((entry) =>
                          entry.id === tag.id ? { ...entry, hue: Number(event.target.value) } : entry,
                        ),
                      )
                    }
                    aria-label={`Colour for ${tag.name}`}
                  />
                  <span className="dash-row__meta">
                    {count} login{count === 1 ? '' : 's'}
                    {usedBy ? ` · ${usedBy} channel${usedBy === 1 ? '' : 's'}` : ''}
                  </span>
                  <button className="btn btn--icon" aria-label={`Delete tag ${tag.name}`} onClick={() => removeTag(tag)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="dash-create">
          <input
            className="input"
            value={newName}
            placeholder="New tag name"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addTag();
              }
            }}
          />
          <button className="btn btn--secondary" onClick={addTag} disabled={!newName.trim()}>
            Add
          </button>
          {tags.some((tag) => (perTag.get(tag.id) ?? 0) === 0) ? (
            <button
              className="btn btn--quiet"
              onClick={() => {
                const unused = tags.filter((tag) => (perTag.get(tag.id) ?? 0) === 0);
                for (const tag of unused) onScrubTag(tag.id);
                onTagsChange(tags.filter((tag) => (perTag.get(tag.id) ?? 0) > 0));
                onNotify(`Removed ${unused.length} unused tag${unused.length === 1 ? '' : 's'}`);
              }}
            >
              Clear unused
            </button>
          ) : null}
        </div>
      </section>

      {/* Mail used to render here. It moved onto the login cards themselves —
          an expander per login — because an inbox dump on the summary screen
          answered nobody's question: the screen is about vault health, and
          twenty unrelated messages buried it. */}

      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Channels</h2>
            <p className="dash-section__hint">Every sidebar view. Right-click one in the sidebar to edit it.</p>
          </div>
          <button className="btn btn--secondary" onClick={onNewChannel}>
            New channel
          </button>
        </header>
        <div className="dash-list">
          {channels.map((channel) => (
            <div className="dash-row" key={channel.id}>
              <span className="dash-row__dot" style={{ background: `hsl(${channel.hue} 46% 54%)` }} />
              <button className="dash-row__name" onClick={() => onSelectChannel(channel.id)} title={`Show ${channel.name}`}>
                {channel.name}
              </button>
              {channel.builtin ? <span className="dash-row__badge">built-in</span> : null}
              <span className="dash-row__meta">
                {channel.tagIds.length === 0
                  ? CHANNEL_KIND_LABELS[channel.kind]
                  : `${channel.tagIds.length} tag${channel.tagIds.length === 1 ? '' : 's'}`}
              </span>
              <span className="dash-row__count">{perChannel.get(channel.id) ?? 0}</span>
              <button
                className="btn btn--icon"
                aria-label={`Edit channel ${channel.name}`}
                onClick={() => onEditChannel(channel.id)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Allowed reminder windows, kept here so the dashboard matches Settings. */
const REMINDER_DAYS = {
  password: [0, 30, 60, 90, 180, 365, 730],
  emailCheck: [0, 30, 90, 180, 365],
  emailAge: [0, 90, 180, 365, 730],
} as const;



