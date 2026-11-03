/**
 * Email Roadmap: every address in the vault, what it is connected to, and the
 * logins it opens.
 *
 * Three questions that used to require three screens:
 *
 *   - Which logins live under this address?
 *   - Which mailbox is actually connected, and to what server?
 *   - Which addresses are saved or disposable but not used yet?
 *
 * The screen answers them as a route map: one line per address, its mailbox
 * state at the start, and the services it opens as stops along the track. It
 * is also a Dashboard tab, so the same map is one click from the overview.
 *
 * Hovering any login opens a cursor-anchored detail card. The card is portalled
 * to the body so a scrolling pane cannot clip it, flips at the viewport edges,
 * closes on Escape, and keeps itself open while the pointer moves into it —
 * the interaction rules from Chrome's hovercard guidance and the 21st.dev
 * tooltip/popover/hover-card contract. Everything inside it is also reachable
 * by opening the login, so the card is a preview, never the only route.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { isSecured } from '../crypto/security.ts';
import { accountLabel, providerById, resolveConnection } from '../lib/mail-providers.ts';
import { maskEmail } from '../vault/site-intel.ts';
import type { Tag } from '../vault/channels.ts';
import {
  buildEmailRoadmap,
  EMAIL_IDENTITY_LABELS,
  type EmailIdentity,
  type EmailIdentityStatus,
} from '../vault/email-roadmap.ts';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import { accentOf, hostnameOf, isWeakPassword, relativeTime, type VaultItem } from '../vault/types.ts';
import { avatarSrc } from './card-art.ts';
import { hasMailCreds } from './useGmail.ts';
import {
  AlertIcon,
  ClockIcon,
  CopyIcon,
  EditIcon,
  ExternalIcon,
  InboxIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  StarIcon,
  TagIcon,
  XIcon,
} from './icons.tsx';

type RoadmapTab = 'map' | 'addresses' | 'mailboxes' | 'unlinked';
type IdentityFilter = 'all' | EmailIdentityStatus;

const TAB_LABELS: { id: RoadmapTab; label: string; hint: string }[] = [
  { id: 'map', label: 'Roadmap', hint: 'Every address and the logins it opens' },
  { id: 'addresses', label: 'Addresses', hint: 'Audit one address at a time' },
  { id: 'mailboxes', label: 'Mailboxes', hint: 'Connected accounts and their servers' },
  { id: 'unlinked', label: 'Unlinked', hint: 'Logins with no address at all' },
];

const FILTER_LABELS: { id: IdentityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'saved', label: 'Saved' },
  { id: 'disposable', label: 'Disposable' },
  { id: 'vault', label: 'Vault' },
];

const GROUP_HINTS: Record<EmailIdentityStatus, string> = {
  connected: 'Mailboxes the vault can read. Their addresses map to the logins below.',
  saved: 'Addresses kept for reuse. No mailbox is connected to them.',
  disposable: 'Temporary Mohmal inboxes attached to a login.',
  vault: 'Addresses that appear on a login but are not connected or saved.',
};

const GROUP_ORDER: EmailIdentityStatus[] = ['connected', 'saved', 'disposable', 'vault'];

interface HoverState {
  item: VaultItem;
  identity: EmailIdentity | null;
  x: number;
  y: number;
}

/** Everything the detail card and the row buttons need from the host screen. */
interface RoadmapActions {
  onOpenLogin: (item: VaultItem) => void;
  onOpenMailbox?: (accountId: string) => void;
  onOpenSettings?: (tab: string) => void;
  onAddLogin?: () => void;
  onCopy?: (value: string, label: string, item?: VaultItem) => void;
  onOpenUrl?: (item: VaultItem) => void;
  onOpenExternal?: (url: string) => void;
}

interface HoverControls {
  show: (item: VaultItem, identity: EmailIdentity | null, x: number, y: number) => void;
  showAt: (item: VaultItem, identity: EmailIdentity | null, element: HTMLElement) => void;
  hide: () => void;
}

export function EmailRoadmap({
  items,
  accounts,
  reusableEmails,
  mailCache,
  tags,
  maskEmails = false,
  embedded = false,
  onOpenLogin,
  onOpenMailbox,
  onOpenSettings,
  onAddLogin,
  onCopy,
  onOpenUrl,
  onOpenExternal,
}: {
  items: VaultItem[];
  accounts: GmailAccount[];
  reusableEmails: string[];
  mailCache?: Record<string, CachedMailMessage[]>;
  tags: Tag[];
  maskEmails?: boolean;
  /** The Dashboard embeds the same screen under its own tab strip. */
  embedded?: boolean;
} & RoadmapActions) {
  const [tab, setTab] = useState<RoadmapTab>('map');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<IdentityFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const hoverRef = useRef<HoverState | null>(null);
  hoverRef.current = hover;
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const roadmap = useMemo(
    () => buildEmailRoadmap(items, accounts, reusableEmails, mailCache ?? {}),
    [items, accounts, reusableEmails, mailCache],
  );

  const tagName = useCallback(
    (tagId: string) => tags.find((tag) => tag.id === tagId)?.name ?? '',
    [tags],
  );

  const clearOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeHover = useCallback(() => {
    clearOpen();
    clearClose();
    setHover(null);
  }, [clearOpen, clearClose]);

  /**
   * Shows the card at the pointer. Moving over the *same* login repositions it
   * only after a small threshold, so following the cursor does not repaint the
   * whole card on every pixel; moving to a different login switches at once.
   * The first open waits 140ms of intent, which is what stops a sweep across a
   * row of stops from flashing a card per stop.
   */
  const showHover = useCallback(
    (item: VaultItem, identity: EmailIdentity | null, x: number, y: number) => {
      clearClose();
      const current = hoverRef.current;
      if (current?.item.id === item.id) {
        if (Math.abs(current.x - x) + Math.abs(current.y - y) > 12) {
          setHover({ ...current, x, y });
        }
        return;
      }
      clearOpen();
      if (current) {
        setHover({ item, identity, x, y });
        return;
      }
      openTimer.current = window.setTimeout(() => {
        setHover({ item, identity, x, y });
        openTimer.current = null;
      }, 140);
    },
    [clearClose, clearOpen],
  );

  const showHoverAt = useCallback(
    (item: VaultItem, identity: EmailIdentity | null, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      showHover(item, identity, rect.left + rect.width / 2, rect.bottom - 8);
    },
    [showHover],
  );

  /** Closing is delayed so the diagonal path from a stop into the card survives. */
  const hideHover = useCallback(() => {
    clearOpen();
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      setHover(null);
      closeTimer.current = null;
    }, 190);
  }, [clearOpen, clearClose]);

  const stayHover = useCallback(() => {
    clearOpen();
    clearClose();
  }, [clearOpen, clearClose]);

  const hoverControls: HoverControls = { show: showHover, showAt: showHoverAt, hide: hideHover };

  const query = search.trim().toLowerCase();
  const matchesQuery = useCallback(
    (identity: EmailIdentity): boolean => {
      if (!query) return true;
      return (
        identity.address.toLowerCase().includes(query) ||
        identity.domains.some((domain) => domain.includes(query)) ||
        identity.tagIds.some((tagId) => tagName(tagId).toLowerCase().includes(query)) ||
        identity.logins.some((item) =>
          `${item.title} ${item.username} ${item.url}`.toLowerCase().includes(query),
        )
      );
    },
    [query, tagName],
  );

  const visibleIdentities = useMemo(
    () =>
      roadmap.identities.filter(
        (identity) =>
          (filter === 'all' || identity.statuses.includes(filter)) && matchesQuery(identity),
      ),
    [roadmap.identities, filter, matchesQuery],
  );

  const grouped = useMemo(
    () =>
      GROUP_ORDER.map((status) => ({
        status,
        rows: visibleIdentities.filter((identity) => identity.primary === status),
      })).filter((group) => group.rows.length > 0),
    [visibleIdentities],
  );

  const visibleAccounts = useMemo(() => {
    if (!query) return accounts;
    return accounts.filter(
      (account) =>
        account.address.toLowerCase().includes(query) ||
        accountLabel(account).toLowerCase().includes(query) ||
        resolveConnection(account).host.toLowerCase().includes(query),
    );
  }, [accounts, query]);

  const visibleUnlinked = useMemo(() => {
    if (!query) return roadmap.unlinked;
    return roadmap.unlinked.filter((item) =>
      `${item.title} ${item.username} ${item.url}`.toLowerCase().includes(query),
    );
  }, [roadmap.unlinked, query]);

  const stats = [
    { label: 'Addresses', value: roadmap.identities.length, note: 'in the roadmap' },
    { label: 'Connected', value: roadmap.counts.connected, note: 'mailboxes' },
    { label: 'Disposable', value: roadmap.counts.disposable, note: 'temporary inboxes' },
    { label: 'Unlinked', value: roadmap.unlinked.length, note: 'logins with no address' },
  ];

  return (
    <div className={embedded ? 'eroad eroad--embedded' : 'eroad'}>
      <header className="eroad__head">
        <div>
          <p className="cc-eyebrow">Mail connections</p>
          <h1 className="cc-title">Email Roadmap</h1>
          <p className="cc-sub">
            {roadmap.identities.length === 0
              ? 'No address is in the vault yet. Add one to a login and the map draws itself.'
              : `${roadmap.identities.length} address${roadmap.identities.length === 1 ? '' : 'es'} mapped to ${roadmap.linkedLogins} login${roadmap.linkedLogins === 1 ? '' : 's'}. Hover a login for everything about it.`}
          </p>
        </div>
        <div className="eroad__actions">
          {onOpenSettings ? (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onOpenSettings('channels')}>
              <SettingsIcon width="14" height="14" />
              Manage mail
            </button>
          ) : null}
          {onAddLogin ? (
            <button type="button" className="btn btn--champagne" onClick={onAddLogin}>
              <PlusIcon width="14" height="14" />
              New login
            </button>
          ) : null}
        </div>
      </header>

      <div className="eroad__stats" role="list" aria-label="Email roadmap summary">
        {stats.map((stat) => (
          <div className="eroad-stat" role="listitem" key={stat.label}>
            <span className="eroad-stat__value">{stat.value}</span>
            <span className="eroad-stat__label">{stat.label}</span>
            <span className="eroad-stat__note">{stat.note}</span>
          </div>
        ))}
      </div>

      <div className="eroad__tabs">
        <div className="segmented" role="tablist" aria-label="Email roadmap sections">
          {TAB_LABELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="segmented__option"
              aria-selected={tab === entry.id}
              aria-pressed={tab === entry.id}
              title={entry.hint}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {entry.id === 'unlinked' && roadmap.unlinked.length > 0 ? (
                <span className="eroad-tab__count">{roadmap.unlinked.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="eroad__toolbar">
        <label className="eroad-search">
          <SearchIcon width="14" height="14" />
          <input
            type="search"
            value={search}
            placeholder="Search address, login, service or tag"
            aria-label="Search the email roadmap"
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button type="button" className="eroad-search__clear" aria-label="Clear search" onClick={() => setSearch('')}>
              <XIcon width="12" height="12" />
            </button>
          ) : null}
        </label>
        {tab === 'map' || tab === 'addresses' ? (
          <div className="eroad-filters" role="group" aria-label="Filter addresses">
            {FILTER_LABELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="eroad-filter"
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {tab === 'map' ? (
        grouped.length === 0 ? (
          <RoadmapEmpty
            title={roadmap.identities.length === 0 ? 'No addresses yet' : 'Nothing matches'}
            body={
              roadmap.identities.length === 0
                ? 'A login whose email field holds an address starts a route here. Connect a mailbox and the route gains an inbox.'
                : 'Try a different search, or clear the status filter.'
            }
            onAddLogin={onAddLogin}
          />
        ) : (
          <div className="eroad-groups">
            {grouped.map((group) => (
              <section className="eroad-group" key={group.status}>
                <header className="eroad-group__head">
                  <span className="eroad-group__dot" data-status={group.status} aria-hidden="true" />
                  <h2 className="eroad-group__title">{EMAIL_IDENTITY_LABELS[group.status]}</h2>
                  <span className="eroad-group__count">{group.rows.length}</span>
                  <p className="eroad-group__hint">{GROUP_HINTS[group.status]}</p>
                </header>
                <div className="eroad-routes">
                  {group.rows.map((identity) => (
                    <IdentityRoute
                      key={identity.key}
                      identity={identity}
                      tagName={tagName}
                      maskEmails={maskEmails}
                      hover={hoverControls}
                      actions={{ onOpenLogin, onOpenMailbox, onOpenSettings, onAddLogin, onCopy, onOpenUrl, onOpenExternal }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      ) : null}

      {tab === 'addresses' ? (
        visibleIdentities.length === 0 ? (
          <RoadmapEmpty
            title="No address matches"
            body="Clear the search or the status filter to see the full address list."
            onAddLogin={onAddLogin}
          />
        ) : (
          <div className="eroad-table" role="table" aria-label="Every address">
            <div className="eroad-table__head" role="row">
              <span role="columnheader">Address</span>
              <span role="columnheader">Connected to</span>
              <span role="columnheader">Logins</span>
              <span role="columnheader">Last activity</span>
              <span aria-hidden="true" />
            </div>
            {visibleIdentities.map((identity) => {
              const isOpen = expanded === identity.key;
              const account = identity.accounts[0];
              return (
                <div className="eroad-table__entry" key={identity.key}>
                  <div
                    className="eroad-table__row"
                    role="row"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    aria-label={`Inspect ${identity.address}`}
                    onClick={() => setExpanded(isOpen ? null : identity.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setExpanded(isOpen ? null : identity.key);
                      }
                    }}
                  >
                    <span className="eroad-table__cell eroad-table__cell--address" role="cell">
                      <span className="eroad-group__dot" data-status={identity.primary} aria-hidden="true" />
                      <span className="eroad-table__address">
                        {maskEmails ? maskEmail(identity.address) : identity.address}
                      </span>
                      <span className="eroad-table__chips">
                        {identity.statuses.map((status) => (
                          <span className="eroad-chip" data-tone={status} key={status}>
                            {EMAIL_IDENTITY_LABELS[status]}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="eroad-table__cell eroad-table__cell--type" role="cell">
                      {account ? (
                        <>
                          <span className="eroad-table__strong">
                            {accountLabel(account)}
                            {!account.enabled ? <span className="eroad-chip" data-tone="off">Off</span> : null}
                          </span>
                          <span className="eroad-table__muted">{resolveConnection(account).host}</span>
                        </>
                      ) : (
                        <span className="eroad-table__muted">{EMAIL_IDENTITY_LABELS[identity.primary]}</span>
                      )}
                    </span>
                    <span className="eroad-table__cell eroad-table__cell--count" role="cell">
                      {identity.logins.length}
                    </span>
                    <span className="eroad-table__cell eroad-table__cell--when" role="cell">
                      {identity.lastUpdated ? relativeTime(identity.lastUpdated) : '—'}
                    </span>
                    <span className="eroad-table__chevron" data-open={isOpen || undefined} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </span>
                  </div>
                  {isOpen ? (
                    <div className="eroad-table__panel">
                      <div className="eroad-table__panel-meta">
                        {identity.domains.length > 0 ? (
                          <span className="eroad-table__muted">
                            Services: {identity.domains.slice(0, 5).join(', ')}
                            {identity.domains.length > 5 ? ` +${identity.domains.length - 5}` : ''}
                          </span>
                        ) : (
                          <span className="eroad-table__muted">No website on these logins yet.</span>
                        )}
                        {account ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => onOpenMailbox?.(account.id)}
                            disabled={!onOpenMailbox}
                          >
                            <InboxIcon width="13" height="13" />
                            Open inbox
                          </button>
                        ) : null}
                      </div>
                      {identity.logins.length === 0 ? (
                        <p className="eroad-route__empty">No login uses this address yet.</p>
                      ) : (
                        <div className="eroad-table__stops">
                          {identity.logins.map((item) => (
                            <LoginStop
                              key={item.id}
                              item={item}
                              identity={identity}
                              maskEmails={maskEmails}
                              hover={hoverControls}
                              onOpen={onOpenLogin}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {tab === 'mailboxes' ? (
        visibleAccounts.length === 0 ? (
          <RoadmapEmpty
            title={accounts.length === 0 ? 'No mailbox connected' : 'No mailbox matches'}
            body={
              accounts.length === 0
                ? 'Connect Gmail, Outlook, Yahoo, iCloud, Fastmail, Zoho, Yandex, AOL, GMX, Proton Bridge or any IMAP server from a login’s Inbox tab.'
                : 'Try a different address, provider or server host.'
            }
            onAddLogin={onAddLogin}
          />
        ) : (
          <div className="eroad-mailboxes">
            {visibleAccounts.map((account) => (
              <MailboxCard
                key={account.id}
                account={account}
                identity={roadmap.identities.find((entry) => entry.accounts.some((candidate) => candidate.id === account.id)) ?? null}
                cached={mailCache?.[account.id] ?? []}
                maskEmails={maskEmails}
                onOpenMailbox={onOpenMailbox}
                onOpenSettings={onOpenSettings}
                onOpenExternal={onOpenExternal}
              />
            ))}
          </div>
        )
      ) : null}

      {tab === 'unlinked' ? (
        visibleUnlinked.length === 0 ? (
          <RoadmapEmpty
            title={roadmap.unlinked.length === 0 ? 'Every login has an address' : 'No unlinked login matches'}
            body={
              roadmap.unlinked.length === 0
                ? 'Nothing to tidy here. Every login in the vault carries an email address or a disposable inbox.'
                : 'Try a different title or website.'
            }
            onAddLogin={onAddLogin}
          />
        ) : (
          <div className="eroad-unlinked">
            {visibleUnlinked.map((item) => (
              <div
                className="eroad-unlinked__row"
                key={item.id}
                onMouseEnter={(event) => showHover(item, null, event.clientX, event.clientY)}
                onMouseMove={(event) => showHover(item, null, event.clientX, event.clientY)}
                onMouseLeave={hideHover}
                onFocus={(event) => showHoverAt(item, null, event.currentTarget)}
                onBlur={hideHover}
              >
                <span className="eroad-unlinked__dot" style={{ '--stop-h': String(accentOf(item)) } as CSSProperties} aria-hidden="true" />
                <span className="eroad-unlinked__body">
                  <button type="button" className="eroad-unlinked__title" onClick={() => onOpenLogin(item)}>
                    {item.title || item.username || hostnameOf(item.url) || 'Untitled login'}
                  </button>
                  <span className="eroad-unlinked__meta">
                    {hostnameOf(item.url) ?? 'No website'} · updated {relativeTime(item.updatedAt)}
                  </span>
                </span>
                <span className="eroad-unlinked__tags">
                  {item.tags.slice(0, 3).map((tagId) => {
                    const name = tagName(tagId);
                    return name ? (
                      <span className="eroad-chip" data-tone="vault" key={tagId}>
                        {name}
                      </span>
                    ) : null;
                  })}
                </span>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpenLogin(item)}>
                  <EditIcon width="13" height="13" />
                  Add address
                </button>
              </div>
            ))}
          </div>
        )
      ) : null}

      {hover
        ? createPortal(
            <LoginHoverCard
              hover={hover}
              tags={tags}
              maskEmails={maskEmails}
              onStay={stayHover}
              onLeave={hideHover}
              onClose={closeHover}
              actions={{ onOpenLogin, onOpenMailbox, onOpenSettings, onAddLogin, onCopy, onOpenUrl, onOpenExternal }}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

/** One address as a route: identity at the start, services as stops. */
function IdentityRoute({
  identity,
  tagName,
  maskEmails,
  hover,
  actions,
}: {
  identity: EmailIdentity;
  tagName: (tagId: string) => string;
  maskEmails: boolean;
  hover: HoverControls;
  actions: RoadmapActions;
}) {
  const account = identity.accounts[0];
  const connection = account ? resolveConnection(account) : null;
  const display = maskEmails ? maskEmail(identity.address) : identity.address;
  const tagNames = identity.tagIds.map(tagName).filter(Boolean).slice(0, 3);

  return (
    <article className="eroad-route" data-status={identity.primary}>
      <div className="eroad-route__identity">
        <span className="eroad-route__badge" aria-hidden="true">
          {account ? <MailIcon width="15" height="15" /> : identity.tempLogins.length > 0 ? <ClockIcon width="15" height="15" /> : <RouteIcon width="15" height="15" />}
        </span>
        <div className="eroad-route__name">
          <span className="eroad-route__address" title={identity.address}>
            {display}
          </span>
          <span className="eroad-route__chips">
            {identity.statuses.map((status) => (
              <span className="eroad-chip" data-tone={status} key={status}>
                {EMAIL_IDENTITY_LABELS[status]}
              </span>
            ))}
            {account && !account.enabled ? (
              <span className="eroad-chip" data-tone="off">
                Off
              </span>
            ) : null}
          </span>
          {connection ? <span className="eroad-route__server">{connection.label} · {connection.host}</span> : null}
          {tagNames.length > 0 ? (
            <span className="eroad-route__tags">
              {tagNames.map((name) => (
                <span className="eroad-chip eroad-chip--tag" key={name}>
                  <TagIcon width="10" height="10" />
                  {name}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <div className="eroad-route__meta">
          <span>
            {identity.logins.length} login{identity.logins.length === 1 ? '' : 's'}
          </span>
          <span>{identity.lastUpdated ? relativeTime(identity.lastUpdated) : 'never used'}</span>
          {identity.weakCount > 0 ? (
            <span className="eroad-route__warning">
              <AlertIcon width="11" height="11" />
              {identity.weakCount} weak
            </span>
          ) : null}
        </div>
      </div>

      <span className="eroad-route__track" aria-hidden="true">
        <span className="eroad-route__track-dot" />
      </span>

      <div className="eroad-route__stops" aria-label={`Logins under ${identity.address}`}>
        {identity.logins.length === 0 ? (
          <p className="eroad-route__empty">No login uses this address yet.</p>
        ) : (
          identity.logins.map((item) => (
            <LoginStop
              key={item.id}
              item={item}
              identity={identity}
              maskEmails={maskEmails}
              hover={hover}
              onOpen={actions.onOpenLogin}
            />
          ))
        )}
      </div>

      <div className="eroad-route__actions">
        {account ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => actions.onOpenMailbox?.(account.id)}
            disabled={!actions.onOpenMailbox}
            title={`Open ${identity.address} in the mail centre`}
          >
            <InboxIcon width="13" height="13" />
            Inbox
          </button>
        ) : null}
        {actions.onCopy ? (
          <button
            type="button"
            className="btn btn--quiet btn--icon"
            aria-label={`Copy ${identity.address}`}
            title="Copy address"
            onClick={() => actions.onCopy?.(identity.address, 'Email address')}
          >
            <CopyIcon width="14" height="14" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** One clickable stop on a route. Hover opens the cursor card; click opens it. */
function LoginStop({
  item,
  identity,
  maskEmails,
  hover,
  onOpen,
}: {
  item: VaultItem;
  identity: EmailIdentity;
  maskEmails: boolean;
  hover: HoverControls;
  onOpen: (item: VaultItem) => void;
}) {
  const host = hostnameOf(item.url);
  const weak = isWeakPassword(item);
  const secured = Boolean(item.totpSecret) || isSecured(item.security);
  return (
    <button
      type="button"
      className="eroad-stop"
      title={`${item.title || item.username || host || 'Login'} — hover for details, click to open`}
      onMouseEnter={(event: ReactMouseEvent) => hover.show(item, identity, event.clientX, event.clientY)}
      onMouseMove={(event: ReactMouseEvent) => hover.show(item, identity, event.clientX, event.clientY)}
      onMouseLeave={hover.hide}
      onFocus={(event) => hover.showAt(item, identity, event.currentTarget)}
      onBlur={hover.hide}
      onClick={() => onOpen(item)}
    >
      <span className="eroad-stop__dot" style={{ '--stop-h': String(accentOf(item)) } as CSSProperties} aria-hidden="true" />
      <span className="eroad-stop__body">
        <span className="eroad-stop__title">{item.title || item.username || host || 'Untitled login'}</span>
        <span className="eroad-stop__meta">
          {maskEmails && item.username ? maskEmail(item.username) : host || item.username || 'No website'}
        </span>
      </span>
      <span className="eroad-stop__flags">
        {weak ? <span className="eroad-stop__flag" data-tone="weak" title="Weak or reused password">!</span> : null}
        {secured ? <ShieldIcon width="11" height="11" className="eroad-stop__shield" aria-label="Second factor" /> : null}
      </span>
    </button>
  );
}

function MailboxCard({
  account,
  identity,
  cached,
  maskEmails,
  onOpenMailbox,
  onOpenSettings,
  onOpenExternal,
}: {
  account: GmailAccount;
  identity: EmailIdentity | null;
  cached: CachedMailMessage[];
  maskEmails: boolean;
  onOpenMailbox?: (accountId: string) => void;
  onOpenSettings?: (tab: string) => void;
  onOpenExternal?: (url: string) => void;
}) {
  const connection = resolveConnection(account);
  const provider = providerById(connection.provider);
  const ready = account.enabled && hasMailCreds(account);
  const latest =
    [...cached].sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''))[0] ?? null;
  const cadence =
    account.refreshSeconds <= 0
      ? 'Manual checks'
      : account.refreshSeconds >= 60
        ? `Every ${Math.round(account.refreshSeconds / 60)} min`
        : `Every ${account.refreshSeconds}s`;
  const address = maskEmails ? maskEmail(account.address) : account.address;

  return (
    <article className="eroad-mailbox" data-ready={ready || undefined}>
      <header className="eroad-mailbox__head">
        <span className="eroad-mailbox__badge" aria-hidden="true">
          <MailIcon width="16" height="16" />
        </span>
        <div className="eroad-mailbox__name">
          <span className="eroad-mailbox__address" title={account.address}>{address || 'No address'}</span>
          <span className="eroad-mailbox__provider">{provider.label}</span>
        </div>
        <span className="eroad-mailbox__status" data-state={ready ? 'on' : account.enabled ? 'warn' : 'off'}>
          {ready ? 'Connected' : account.enabled ? 'Needs credentials' : 'Off'}
        </span>
      </header>

      <dl className="eroad-mailbox__meta">
        <div>
          <dt>Server</dt>
          <dd>{connection.host || '—'}:{connection.port}</dd>
        </div>
        <div>
          <dt>Security</dt>
          <dd>{connection.secure ? 'TLS' : 'STARTTLS / plain'}</dd>
        </div>
        <div>
          <dt>Sign-in</dt>
          <dd>{account.auth === 'oauth' ? 'OAuth' : 'App password'}</dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>{cadence}</dd>
        </div>
        <div>
          <dt>Cached</dt>
          <dd>{cached.length} message{cached.length === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt>Mapped logins</dt>
          <dd>{identity?.logins.length ?? 0}</dd>
        </div>
      </dl>

      <div className="eroad-mailbox__latest">
        <span className="eroad-mailbox__latest-label">Newest cached message</span>
        {latest ? (
          <>
            <span className="eroad-mailbox__latest-subject">{latest.title || '(no subject)'}</span>
            <span className="eroad-mailbox__latest-meta">
              {latest.author || latest.email || 'Unknown sender'} ·{' '}
              {Number.isFinite(Date.parse(latest.issued || '')) ? relativeTime(Date.parse(latest.issued)) : 'unknown date'}
            </span>
          </>
        ) : (
          <span className="eroad-mailbox__latest-meta">Nothing cached yet. Open the inbox and the newest mail lands here.</span>
        )}
      </div>

      <footer className="eroad-mailbox__actions">
        <button
          type="button"
          className={ready ? 'btn btn--champagne btn--sm' : 'btn btn--secondary btn--sm'}
          onClick={() => onOpenMailbox?.(account.id)}
          disabled={!onOpenMailbox}
          title={ready ? 'Open this mailbox' : 'This mailbox is switched off or needs credentials'}
        >
          <InboxIcon width="13" height="13" />
          Open inbox
        </button>
        {onOpenSettings ? (
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpenSettings('channels')}>
            <SettingsIcon width="13" height="13" />
            Manage
          </button>
        ) : null}
        {provider.appPasswordUrl && account.auth !== 'oauth' ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => onOpenExternal?.(provider.appPasswordUrl)}
            disabled={!onOpenExternal}
          >
            <ExternalIcon width="13" height="13" />
            App password
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function RoadmapEmpty({
  title,
  body,
  onAddLogin,
}: {
  title: string;
  body: string;
  onAddLogin?: () => void;
}) {
  return (
    <section className="eroad-empty">
      <span className="eroad-empty__mark" aria-hidden="true">
        <RouteIcon width="24" height="24" />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {onAddLogin ? (
        <button type="button" className="btn btn--champagne" onClick={onAddLogin}>
          <PlusIcon width="14" height="14" />
          Add a login
        </button>
      ) : null}
    </section>
  );
}

/**
 * The cursor-anchored detail card.
 *
 * Portalled to the body, so no `overflow` ancestor can clip it; positioned
 * fixed and flipped/shifted to stay inside the viewport; scrollable in the
 * middle with its header and actions pinned. `onStay` cancels the pending
 * close when the pointer crosses the gap from the stop into the card.
 */
function LoginHoverCard({
  hover,
  tags,
  maskEmails,
  onStay,
  onLeave,
  onClose,
  actions,
}: {
  hover: HoverState;
  tags: Tag[];
  maskEmails: boolean;
  onStay: () => void;
  onLeave: () => void;
  onClose: () => void;
  actions: RoadmapActions;
}) {
  const { item, identity, x, y } = hover;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const pad = 12;
    const gap = 18;
    let left = x + gap;
    let top = y + gap;
    if (left + rect.width > window.innerWidth - pad) left = x - rect.width - gap;
    if (top + rect.height > window.innerHeight - pad) top = y - rect.height - gap;
    left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - rect.height - pad));
    setPos((current) =>
      current && Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5
        ? current
        : { left, top },
    );
  }, [x, y, item.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && cardRef.current?.contains(target)) return;
      onClose();
    };
    const onResize = () => onClose();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && cardRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const host = hostnameOf(item.url);
  const title = item.title || item.username || host || 'Untitled login';
  const source = avatarSrc(item);
  const hue = accentOf(item);
  const secured = Boolean(item.totpSecret) || isSecured(item.security);
  const weak = isWeakPassword(item);
  const tagNames = item.tags.map((tagId) => tags.find((tag) => tag.id === tagId)?.name ?? '').filter(Boolean);
  const account = identity?.accounts[0] ?? null;
  const mailbox = account ? resolveConnection(account) : null;
  const tempExpiry = item.tempMail
    ? new Date(item.tempMail.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const field = (label: string, value: string, wide = false) => (
    <div className={wide ? 'eroad-hover__field eroad-hover__field--wide' : 'eroad-hover__field'} key={label}>
      <span className="eroad-hover__label">{label}</span>
      <span className="eroad-hover__value">{value}</span>
    </div>
  );

  return (
    <div
      ref={cardRef}
      className="eroad-hover"
      role="dialog"
      aria-label={`${title} details`}
      style={
        pos
          ? { left: `${pos.left}px`, top: `${pos.top}px` }
          : { left: '-9999px', top: '-9999px' }
      }
      onMouseEnter={onStay}
      onMouseLeave={onLeave}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="eroad-hover__head">
        <span
          className="eroad-hover__avatar"
          style={{ '--stop-h': String(hue) } as CSSProperties}
          aria-hidden="true"
        >
          {source ? <img src={source} alt="" /> : <span>{title.slice(0, 1).toUpperCase()}</span>}
        </span>
        <span className="eroad-hover__identity">
          <span className="eroad-hover__title">{title}</span>
          <span className="eroad-hover__sub">{host ?? 'No website saved'}</span>
          <span className="eroad-hover__chips">
            {identity?.statuses.map((status) => (
              <span className="eroad-chip" data-tone={status} key={status}>
                {EMAIL_IDENTITY_LABELS[status]}
              </span>
            ))}
            {weak ? (
              <span className="eroad-chip" data-tone="weak">
                <AlertIcon width="10" height="10" />
                Weak password
              </span>
            ) : null}
            {secured ? (
              <span className="eroad-chip" data-tone="secured">
                <ShieldIcon width="10" height="10" />
                Second factor
              </span>
            ) : null}
            {item.needsAttention ? (
              <span className="eroad-chip" data-tone="attention">
                Needs attention
              </span>
            ) : null}
            {item.favorite ? (
              <span className="eroad-chip" data-tone="favorite">
                <StarIcon width="10" height="10" filled />
                Favorite
              </span>
            ) : null}
          </span>
        </span>
      </header>

      <div className="eroad-hover__scroll">
        <div className="eroad-hover__grid">
          {field('Email', maskEmails ? maskEmail(item.username) : item.username || '—')}
          {field('Website', host ?? '—')}
          {field('Added', relativeTime(item.createdAt))}
          {field('Updated', relativeTime(item.updatedAt))}
          {field('Password changed', relativeTime(item.passwordUpdatedAt))}
          {field('Tags', tagNames.length > 0 ? tagNames.join(', ') : 'No tags')}
          {field('Second factor', item.totpSecret ? 'Authenticator seed' : secured ? 'Recovery / passcode' : 'None')}
          {identity && identity.logins.length > 1 ? field('Same address on', `${identity.logins.length} logins`) : null}
          {account && mailbox ? field('Mailbox', `${accountLabel(account)} · ${mailbox.host}`) : null}
          {item.tempMail ? field('Disposable inbox', `${item.tempMail.address}${tempExpiry ? ` · expires ${tempExpiry}` : ''}`) : null}
          {item.shareLink ? field('Origin', 'Linked copy from a share') : null}
          {item.url ? field('URL', item.url, true) : null}
        </div>

        {item.notes.trim() ? (
          <section className="eroad-hover__notes">
            <span className="eroad-hover__label">Notes</span>
            <p>{item.notes}</p>
          </section>
        ) : null}

        <p className="eroad-hover__hint">
          The card stays open while you move into it. Scroll here, press Escape to close, or open the login for the full editor.
        </p>
      </div>

      <footer className="eroad-hover__actions">
        <button type="button" className="btn btn--champagne btn--sm" onClick={() => actions.onOpenLogin(item)}>
          <EditIcon width="13" height="13" />
          Open login
        </button>
        {actions.onCopy && item.username ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => actions.onCopy?.(item.username, 'Email', item)}>
            <CopyIcon width="13" height="13" />
            Copy email
          </button>
        ) : null}
        {actions.onCopy && item.password ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => actions.onCopy?.(item.password, 'Password', item)}>
            <CopyIcon width="13" height="13" />
            Copy password
          </button>
        ) : null}
        {actions.onOpenUrl && item.url ? (
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => actions.onOpenUrl?.(item)}>
            <ExternalIcon width="13" height="13" />
            Open site
          </button>
        ) : null}
        {account && actions.onOpenMailbox ? (
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => actions.onOpenMailbox?.(account.id)}>
            <InboxIcon width="13" height="13" />
            Inbox
          </button>
        ) : null}
      </footer>
    </div>
  );
}
