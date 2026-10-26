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
  active: boolean;
  items: VaultItem[];
  onUpdates: (updates: TempMailRenewUpdate[]) => Promise<void> | void;
  onError?: (message: string) => void;
}): void {
  const { active, items, onUpdates, onError } = input;
  const itemsRef = useRef(items);
  const updatesRef = useRef(onUpdates);
  const errorRef = useRef(onError);
  const syncing = useRef(false);
  const hadSchedules = useRef(false);
  itemsRef.current = items;
  updatesRef.current = onUpdates;
  errorRef.current = onError;

  const sync = useCallback(async () => {
    if (syncing.current) return;
    const api = getPlatform().tempMail;
    if (!api) return;
    syncing.current = true;
    try {
      const schedules: TempMailSchedule[] = [];
      for (const item of itemsRef.current) {
        if (item.tempMail) schedules.push({ itemId: item.id, mailbox: item.tempMail });
      }
      const result = await api.syncSchedules(schedules);
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
    if (!active) return;
    const hasSchedules = itemsRef.current.some((item) => item.tempMail);
    // Do not prune a main-process schedule merely because the first render
    // after unlock has not received the decrypted items yet.
    if (!hasSchedules && !hadSchedules.current) return;
    hadSchedules.current = hasSchedules;
    void sync();
    const timer = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, signature, sync]);
}
