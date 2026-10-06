import { useMemo, useState } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findWeakItems, hostnameOf, relativeTime, type VaultItem } from '../vault/types.ts';
import { applyChannel, createTag, type Channel, type Tag } from '../vault/channels.ts';
import type { VaultPreferences } from '../vault/storage.ts';
import { useGmail } from './useGmail.ts';

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
  onEditChannel,
  onNewChannel,
  onSelectChannel,
  onTagsChange,
  onScrubTag,
  onUpdate,
  onNotify,
}: {
  channels: Channel[];
  tags: Tag[];
  items: VaultItem[];
  prefs: VaultPreferences;
  onEditChannel: (channelId: string) => void;
  onNewChannel: () => void;
  onSelectChannel: (channelId: string) => void;
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
    const stale =
      prefs.passwordAgeDays > 0
        ? items.filter((item) => item.password !== '' && now - item.passwordUpdatedAt > prefs.passwordAgeDays * DAY)
        : [];
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
      withTotp: items.filter((item) => Boolean(item.totpSecret)),
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
  const topDomains = useMemo(() => {
    const byHost = new Map<string, number>();
    for (const item of items) {
      const host = hostnameOf(item.url);
      if (!host) continue;
      // Collapse subdomains so login.example.com and example.com are one row.
      const parts = host.split('.');
      const registrable = parts.length > 2 ? parts.slice(-2).join('.') : host;
      byHost.set(registrable, (byHost.get(registrable) ?? 0) + 1);
    }
    return [...byHost.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
      .slice(0, 8);
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
          { label: 'Stale', value: health.stale.length, target: null },
          { label: 'Email due', value: health.emailCheck.length, target: null },
          { label: 'Untagged', value: health.untagged.length, target: 'unassigned' },
          { label: 'With 2FA', value: health.withTotp.length, target: null },
        ].map((stat, index) => {
          // Resolve by kind so a rebuilt or renamed channel still matches.
          const channelId = stat.target
            ? (stat.target === 'unassigned' ? 'unassigned' : idOf(stat.target as Channel['kind']))
            : null;
          const body = (
            <>
              <span className="stat__value">{stat.value}</span>
              <span className="stat__label">{stat.label}</span>
            </>
          );
          const style = { animationDelay: `${index * 28}ms` } as React.CSSProperties;
          return channelId ? (
            <button
              type="button"
              className="stat stat--link"
              key={stat.label}
              style={style}
              onClick={() => onSelectChannel(channelId)}
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

      {/* Insights. Four things a vault can tell you that the sidebar counts
          cannot: how strong the passwords actually are, which logins share one,
          whether the vault has been touched lately, and where risk is pooled. */}
      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Insights</h2>
            <p className="dash-section__hint">
              Strength across the vault, anything reused, recent activity, and where your logins cluster.
            </p>
          </div>
        </header>

        <div className="dash-insights">
          {/* Strength: a stacked bar, because the point is the proportions
              rather than five separate numbers. */}
          <article className="dash-card">
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
          </article>

          {/* Activity: 30 columns, one per day. */}
          <article className="dash-card">
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
          </article>

          {/* Domains, as proportional bars against the largest. */}
          <article className="dash-card">
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
          </article>

          {/* Reuse clusters. The actionable one: each row is one password and
              every login that shares it. */}
          <article className="dash-card">
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

      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Reminders</h2>
            <p className="dash-section__hint">
              These thresholds drive the counts above and the matching view, so they are editable in one place.
            </p>
          </div>
        </header>
        <div className="dash-reminders">
          <label className="dash-reminder">
            <span className="dash-reminder__label">Change password</span>
            <span className="dash-reminder__count">{health.stale.length} flagged</span>
            <select
              className="select__trigger"
              value={String(prefs.passwordAgeDays)}
              onChange={(event) => set({ passwordAgeDays: Number(event.target.value) })}
            >
              {REMINDER_DAYS.password.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
          </label>

          <label className="dash-reminder">
            <span className="dash-reminder__label">Check email</span>
            <span className="dash-reminder__count">{health.emailCheck.length} due</span>
            <select
              className="select__trigger"
              value={String(prefs.emailCheckDays)}
              onChange={(event) => set({ emailCheckDays: Number(event.target.value) })}
            >
              {REMINDER_DAYS.emailCheck.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
          </label>

          <label className="dash-reminder">
            <span className="dash-reminder__label">Stale email</span>
            <span className="dash-reminder__count">{health.staleEmail.length} flagged</span>
            <select
              className="select__trigger"
              value={String(prefs.emailAgeDays)}
              onChange={(event) => set({ emailAgeDays: Number(event.target.value) })}
            >
              {REMINDER_DAYS.emailAge.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? 'Off' : `${days} days`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="dash-section">
        <header className="dash-section__head">
          <div>
            <h2 className="dash-section__title">Tags</h2>
            <p className="dash-section__hint">
              Rename, recolour or delete. Deleting a tag also removes it from every login and channel using it.
            </p>
          </div>
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

      {prefs.gmail.enabled && prefs.gmail.address ? (
        <InboxSection gmail={prefs.gmail} />
      ) : null}

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
                  ? channel.kind === 'all'
                    ? 'everything'
                    : channel.kind
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


/** The Gmail inbox, polled on the user's own chosen interval. */
function InboxSection({ gmail }: { gmail: VaultPreferences['gmail'] }) {
  const { messages, error, loading } = useGmail({
    enabled: gmail.enabled,
    address: gmail.address,
    appPassword: gmail.appPassword,
    refreshSeconds: gmail.refreshSeconds,
  });

  return (
    <section className="dash-section">
      <header className="dash-section__head">
        <div>
          <h2 className="dash-section__title">Inbox</h2>
          <p className="dash-section__hint">
            {gmail.address} � re-checks every {gmail.refreshSeconds}s{loading ? ' � refreshing�' : ''}
          </p>
        </div>
      </header>

      {error ? <p className="sec__error">{error}</p> : null}

      {messages.length === 0 && !error ? (
        <p className="dash-card__empty">No recent messages.</p>
      ) : (
        <div className="dash-list">
          {messages.slice(0, 8).map((message) => (
            <a
              key={message.id}
              className="dash-row"
              href={message.alternate}
              target="_blank"
              rel="noreferrer noopener"
              style={{ textDecoration: 'none' }}
            >
              <div className="dash-row__main">
                <span className="dash-row__name">{message.title || '(no subject)'}</span>
                <span className="dash-row__meta">
                  {message.author}
                  {message.issued ? ` � ${relativeTime(Date.parse(message.issued))}` : ''}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
