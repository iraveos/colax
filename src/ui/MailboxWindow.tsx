/**
 * One mailbox's messages in their own window, opened from a dock slot or the
 * dashboard's mail panel.
 *
 * Deliberately thin: all the reading — paging, search, opening a message,
 * caching what came back — lives in `MailMessages`, which the mail centre
 * renders per account too. Two copies of that logic is how the window and the
 * centre would drift apart about what "the mailbox" contains.
 */

import type { GmailMessage } from './useGmail.ts';
import { MailMessages } from './MailMessages.tsx';
import type { CachedMailMessage, GmailAccount } from '../vault/storage.ts';
import { Modal } from './primitives.tsx';
import { accountLabel } from '../lib/mail-providers.ts';

export function MailboxWindow({
  account,
  cache,
  maskEmails,
  onCacheMessages,
  onOpenExternal,
  onClose,
}: {
  account: GmailAccount;
  cache?: Record<string, CachedMailMessage[]>;
  /** Show the first letters of sender addresses only. */
  maskEmails?: boolean;
  onCacheMessages?: (accountId: string, messages: GmailMessage[]) => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`${accountLabel(account)} · ${account.address || 'Mailbox'}`} onClose={onClose} wide>
      <MailMessages
        account={account}
        cache={cache}
        maskEmails={maskEmails}
        onCacheMessages={onCacheMessages}
        onOpenExternal={onOpenExternal}
      />
    </Modal>
  );
}
