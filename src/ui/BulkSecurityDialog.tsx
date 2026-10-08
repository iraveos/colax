/**
 * Bulk security actions for a multi-selection.
 *
 * This is a list of concrete removals rather than an editable security form,
 * and that shape is the whole design decision.
 *
 * The obvious alternative is to show a SecurityForm seeded from the first
 * selected login and write it back to all of them. That is a footgun with two
 * distinct failure modes, and both are silent:
 *
 *   1. Copying one login's TOTP seed onto the others. An authenticator key is
 *      tied to a single credential; six logins sharing one seed means six
 *      logins whose codes all rotate together, and any rotation locks all of
 *      them at once.
 *   2. Clearing factors the user never looked at, because the form opened
 *      pre-filled from a row they were not thinking about.
 *
 * So there is no field to get wrong here. Each row names one factor, says how
 * many of the selection have it, and either removes it or says why it cannot.
 * Nothing is created, because there is no safe way to invent a second factor
 * for someone else's credential.
 */

import { useMemo, useState } from 'react';
import type { VaultItem } from '../vault/types.ts';
import type { LoginSecurity } from '../crypto/security.ts';
import { Modal } from './primitives.tsx';
import { ShieldIcon, TrashIcon } from './icons.tsx';

type Factor = 'totp' | 'passcode' | 'questions';

const FACTORS: { id: Factor; label: string; note: string }[] = [
  {
    id: 'totp',
    label: 'Authenticator key',
    note: 'Cleared so the login opens without a code. The key itself cannot be copied between logins.',
  },
  {
    id: 'passcode',
    label: 'Passcode',
    note: 'Removes the extra password that gates this login.',
  },
  {
    id: 'questions',
    label: 'Recovery questions',
    note: 'Removes every recovery question from the selected logins.',
  },
];

/** True when this login has the named factor set. */
function has(item: VaultItem, factor: Factor): boolean {
  if (factor === 'totp') return Boolean(item.security.totp?.seed);
  if (factor === 'passcode') return Boolean(item.security.passcode);
  return item.security.questions.length > 0;
}

/** The same login with one factor removed, and nothing else touched. */
function without(item: VaultItem, factor: Factor): LoginSecurity {
  if (factor === 'totp') return { ...item.security, totp: null };
  if (factor === 'passcode') return { ...item.security, passcode: null };
  return { ...item.security, questions: [] };
}

export function BulkSecurityDialog({
  items,
  onApply,
  onCancel,
  onNotify,
}: {
  items: readonly VaultItem[];
  onApply: (factor: Factor) => Promise<void>;
  onCancel: () => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  // Confirmation is per factor rather than one dialog-wide yes, because the
  // counts differ and "remove from 4 of 6" is worth reading before committing.
  const [armed, setArmed] = useState<Factor | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const out: Record<Factor, number> = { totp: 0, passcode: 0, questions: 0 };
    for (const item of items) {
      for (const factor of FACTORS) if (has(item, factor.id)) out[factor.id] += 1;
    }
    return out;
  }, [items]);

  const total = items.length;

  return (
    <Modal
      title={`Security on ${total} ${total === 1 ? 'login' : 'logins'}`}
      onClose={onCancel}
      footer={
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Done
        </button>
      }
    >
      <div className="bulk">
        <p className="bulk__lead">
          Nothing here creates a second factor. Each row removes one, and only from the logins that have it.
        </p>

        <ul className="sec__atglance sec__atglance--rows">
          {FACTORS.map((factor) => {
            const count = counts[factor.id];
            const none = count === 0;
            const isArmed = armed === factor.id;
            return (
              <li className="sec__glance" key={factor.id} data-on={count > 0 || undefined} data-armed={isArmed || undefined}>
                <span className="sec__glance-icon" aria-hidden="true">
                  <ShieldIcon />
                </span>
                <span className="sec__glance-body">
                  <span className="sec__glance-title">{factor.label}</span>
                  <span className="sec__glance-note">
                    {none ? `None of the ${total} have this` : `On ${count} of ${total}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  disabled={none || busy}
                  aria-pressed={isArmed}
                  onClick={() => {
                    if (isArmed) {
                      setBusy(true);
                      void onApply(factor.id)
                        .then(() => {
                          setArmed(null);
                          onNotify(`${factor.label} removed`);
                        })
                        .catch(() => onNotify('Could not update', 'error'))
                        .finally(() => setBusy(false));
                      return;
                    }
                    setArmed(factor.id);
                  }}
                >
                  {isArmed ? (
                    <>
                      <TrashIcon width="13" height="13" />
                      Confirm remove
                    </>
                  ) : (
                    'Remove'
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {armed ? (
          <p className="bulk__warn">
            {FACTORS.find((factor) => factor.id === armed)?.note}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export type { Factor };
export { has as hasSecurityFactor, without as withoutSecurityFactor };
