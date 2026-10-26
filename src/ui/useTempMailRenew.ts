/**
 * Keeps the main-process Mohmal renewal scheduler in step with the vault.
 *
 * Mohmal's own "Renew" action resets its 45-minute validity timer. The user
 * chooses how often Colax should call it (ten minutes by default). The actual
 * timer lives in the main process so it keeps running through auto-lock; this
 * hook only registers the saved inboxes while they are readable and collects
 * renewals that happened while the vault was hidden.
 *
 * A renderer-only timer would miss the point: the default auto-lock is five
 * minutes, shorter than the first renewal interval.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getPlatform } from '../lib/platform.ts';
import type { TempMailRenewUpdate, TempMailSchedule } from '../lib/temp-mail.ts';
import type { VaultItem } from '../vault/types.ts';

const SYNC_INTERVAL_MS = 30_000;

export function useTempMailRenew(input: {
  /** True while the vault is unlocked. Locking deliberately leaves schedules running. */
  active: boolean;
  /** True on the create screen: there is no vault to own those inboxes anymore. */
  clear?: boolean;
  items: VaultItem[];
  onUpdates: (updates: TempMailRenewUpdate[]) => Promise<void> | void;
  onError?: (message: string) => void;
}): void {
  const { active, clear = false, items, onUpdates, onError } = input;
  const itemsRef = useRef(items);
  const updatesRef = useRef(onUpdates);
  const errorRef = useRef(onError);
  const activeRef = useRef(active);
  const syncing = useRef(false);
  itemsRef.current = items;
  updatesRef.current = onUpdates;
  errorRef.current = onError;
  activeRef.current = active;

  const clearSchedules = useCallback(async () => {
    const api = getPlatform().tempMail;
    if (!api) return;
    try {
      await api.clearSchedules();
    } catch {
      // Nothing useful to show here; the next unlock or quit cleans up again.
    }
  }, []);

  const sync = useCallback(async () => {
    // A lock can clear `items` while a 30s sync is queued. Never send that
    // empty snapshot to the main process: it would prune the schedules that
    // are supposed to keep renewing through the lock.
    if (!activeRef.current || syncing.current) return;
    const api = getPlatform().tempMail;
    if (!api) return;
    syncing.current = true;
    try {
      const schedules: TempMailSchedule[] = [];
      for (const item of itemsRef.current) {
        if (item.tempMail) schedules.push({ itemId: item.id, mailbox: item.tempMail });
      }
      const result = await api.syncSchedules(schedules);
      if (!activeRef.current) return;
      if (!result.ok) {
        errorRef.current?.(result.error);
        return;
      }
      if (result.updates.length > 0) {
        await updatesRef.current(result.updates);
      }
      for (const error of result.errors) {
        errorRef.current?.(
          `Could not renew ${error.address}: ${error.error} Use Renew now to try again.`,
        );
      }
    } catch (cause) {
      errorRef.current?.(
        cause instanceof Error ? cause.message : 'Could not sync temporary inboxes.',
      );
    } finally {
      syncing.current = false;
    }
  }, []);

  // The signature changes when a renewal lands or the user edits an interval,
  // but not when an unrelated login field changes.
  const signature = items
    .filter((item) => item.tempMail)
    .map(
      (item) =>
        `${item.id}:${item.tempMail?.address}:${item.tempMail?.sessionKey}:${item.tempMail?.autoRenewMinutes}:${item.tempMail?.expiresAt}:${item.tempMail?.lastRenewedAt}`,
    )
    .sort()
    .join('|');

  useEffect(() => {
    if (clear) {
      void clearSchedules();
      return;
    }
    if (!active) return;
    if (!itemsRef.current.some((item) => item.tempMail)) {
      // A vault with no disposable inboxes must not leave a previous vault's
      // schedule renewing. Wait out a one-render gap first: a lock/unlock can
      // briefly hand us an empty item list that must not stop the scheduler.
      const clearTimer = window.setTimeout(() => void clearSchedules(), 2_000);
      return () => window.clearTimeout(clearTimer);
    }
    void sync();
    const timer = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, clear, clearSchedules, signature, sync]);
}
