/**
 * The mail centre: every connected mailbox, one tab each.
 *
 * The vault could already read mail, but only in fragments — a login's
 * expander, or a single mailbox in a small window. There was nowhere to sit and
 * read mail, and with more than one address connected there was no way to see
 * which mailbox you were looking at. This is that screen: a tab per address,
 * each with a real search box and paging back through the whole mailbox.
 *
 * All the reading is `MailMessages`, the same component the per-mailbox window
 * uses, so the two are the same mailbox by construction rather than by
 * agreement.
 */

import { useEffect, useMemo, useState } from 'react';
import { accountLabel, providerById, resolveConnection } from '../lib/mail-providers.ts';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import type { GmailMessage } from './useGmail.ts';
import { MailMessages, MailboxTabs } from './MailMessages.tsx';
import { MailIcon, PlusIcon, SettingsIcon } from './icons.tsx';

export function MailCenter({
  accounts,
  cache,
  maskEmails,
  onCacheMessages,
  onOpenExternal,
  onAddMailbox,
  onOpenSettings,
}: {
  accounts: GmailAccount[];
  cache?: Record<string, CachedMailMessage[]>;
  maskEmails?: boolean;
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  onOpenExternal: (url: string) => void;
  /** Opens the editor for a new login, where a mailbox is connected. */
  onAddMailbox: () => void;
  onOpenSettings: (tab: string) => void;
}) {
  const [activeId, setActiveId] = useState('');
  // Only switched-on accounts get a tab: a mailbox the user disabled is not a
  // place they can read, and a tab that only ever shows an error is furniture.
  const shown = useMemo(() => accounts.filter((account) => account.enabled), [accounts]);

  // Keep the selection valid as mailboxes come and go (connected, removed,
  // switched off) without ever losing the user's place while it is valid.
  useEffect(() => {
    if (shown.length === 0) {
      if (activeId) setActiveId('');
      return;
    }
    if (!shown.some((account) => account.id === activeId)) setActiveId(shown[0]!.id);
  }, [shown, activeId]);

  const active = shown.find((account) => account.id === activeId) ?? null;

  return (
    <div className="mailcenter">
      <header className="mailcenter__head">
        <div>
          <p className="cc-eyebrow">Connected mail</p>
          <h1 className="cc-title">Mail</h1>
          <p className="cc-sub">
            {shown.length === 0
              ? 'No mailbox is connected yet.'
              : `${shown.length} mailbox${shown.length === 1 ? '' : 'es'} connected. Search reaches the whole mailbox, not just what has been read.`}
          </p>
        </div>
        <div className="mailcenter__head-actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => onOpenSettings('channels')}>
            <SettingsIcon width="14" height="14" />
            Manage mail
          </button>
          <button type="button" className="btn btn--champagne" onClick={onAddMailbox}>
            <PlusIcon width="14" height="14" />
            Connect a mailbox
          </button>
        </div>
      </header>

      {shown.length === 0 ? (
        <section className="dash-section">
          <h2 className="dash-section__title">Connect any mail account</h2>
          <p className="dash-section__hint">
            Gmail, Outlook, Yahoo, iCloud, Fastmail, Zoho, Yandex, AOL, GMX, a Proton Bridge or any
            IMAP server of your own — the vault talks IMAP, so the host is a setting rather than a
            hardcoded provider.
          </p>
          <ol className="mailcenter__steps">
            <li>Open a login and go to its Inbox tab.</li>
            <li>Type the address — the provider is recognised from the domain, or pick one by hand.</li>
            <li>Paste an app password from that provider and press Test.</li>
          </ol>
          <div className="mailcenter__cta">
            <button type="button" className="btn btn--champagne" onClick={onAddMailbox}>
              Add a login with a mailbox
            </button>
          </div>
        </section>
      ) : (
        <>
          <MailboxTabs accounts={shown} activeId={activeId} onChange={setActiveId} />
          {active ? (
            <section className="mailcenter__panel">
              <div className="mailcenter__meta">
                <span className="chip chip--accent">
                  <MailIcon width="11" height="11" />
                  {accountLabel(active)}
                </span>
                <span className="chip chip--muted">{resolveConnection(active).host}</span>
                {active.refreshSeconds > 0 ? (
                  <span className="chip chip--muted">
                    auto-check {active.refreshSeconds >= 60 ? `${Math.round(active.refreshSeconds / 60)} min` : `${active.refreshSeconds}s`}
                  </span>
                ) : (
                  <span className="chip chip--muted">manual checks</span>
                )}
                {providerById(active.provider).appPasswordUrl ? (
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => onOpenExternal(providerById(active.provider).appPasswordUrl)}
                  >
                    Create an app password
                  </button>
                ) : null}
              </div>
              {/* Keyed on the account so switching tabs remounts the panel:
                  its paging, search and open message all belong to the mailbox
                  it was read from, never to the one that replaced it. */}
              <MailMessages
                key={active.id}
                account={active}
                cache={cache}
                maskEmails={maskEmails}
                onCacheMessages={onCacheMessages}
                onOpenExternal={onOpenExternal}
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
