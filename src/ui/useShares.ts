/**
 * Sharing lifecycle.
 *
 * Two independent directions, kept out of App's already-large body:
 *   - `useShareServer` publishes the owner's selected logins to Electron while
 *     the vault is unlocked, and stops the listener the moment it locks.
 *   - `useLinkedSync` pulls owner updates into any copies this vault imported.
 *
 * Neither hook touches the vault service. App owns mutations, so the same
 * highlighter, history and encryption path runs for a synced copy as for a
 * hand edit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { syncLinkedShares } from '../lib/share-client.ts';
import { getPlatform } from '../lib/platform.ts';
import {
  type ShareServerConfig,
  type ShareServerEvent,
  type ShareServerStatus,
  type ShareSyncShareResult,
} from '../lib/shares.ts';
import { buildShareSnapshots, linkedTargets } from '../vault/shares.ts';
import type { VaultShare } from '../lib/shares.ts';
import type { VaultItem } from '../vault/types.ts';

function stoppedStatus(error = ''): ShareServerStatus {
  return {
    running: false,
    port: 0,
    host: '',
    hostName: '',
    localUrl: '',
    publicUrl: '',
    error,
    tunnel: 'off',
    tunnelError: '',
  };
}

export function useShareServer(input: {
  active: boolean;
  config: ShareServerConfig;
  shares: VaultShare[];
  items: VaultItem[];
  onEvent: (event: ShareServerEvent) => void;
}): ShareServerStatus {
  const { active, config, shares, items, onEvent } = input;
  const [status, setStatus] = useState<ShareServerStatus>(() => stoppedStatus());
  const sharesRef = useRef(shares);
  const itemsRef = useRef(items);
  const eventRef = useRef(onEvent);
  sharesRef.current = shares;
  itemsRef.current = items;
  eventRef.current = onEvent;

  const snapshotKey = useMemo(() => {
    const shareKey = shares
      .map(
        (share) =>
          `${share.id}:${share.updatedAt}:${share.revision}:${share.revokedAt}:${share.expiresAt}:${share.maxUses}:${share.itemIds.join(',')}:${share.tagIds.join(',')}:${share.fields.notes ? 1 : 0}${share.fields.totp ? 1 : 0}${share.fields.attachments ? 1 : 0}`,
      )
      .join('|');
    const itemKey = items
      .map((item) => `${item.id}:${item.updatedAt}:${item.tags.join(',')}`)
      .join('|');
    return `${shareKey}#${itemKey}`;
  }, [shares, items]);

  useEffect(() => {
    const api = getPlatform().share;
    if (!api || !active) return;
    const stopEvents = api.onEvent((event) => eventRef.current(event));
    const stopStatus = api.onStatus((status) => setStatus(status));
    return () => {
      stopEvents();
      stopStatus();
    };
  }, [active]);

  useEffect(() => {
    const api = getPlatform().share;
    if (!api) {
      setStatus(stoppedStatus('Hosting a share needs the Colax desktop app.'));
      return;
    }
    if (!active) {
      void api.stop().then(setStatus);
      return;
    }
    if (!config.enabled) {
      void api.stop().then(setStatus);
      return;
    }

    let cancelled = false;
    setStatus((current) => ({
      ...current,
      error: '',
      // A prefs write (for example a new access-log row) can re-run this effect
      // without actually reconfiguring anything. Do not flash "starting" over a
      // tunnel that is already live.
      tunnel:
        config.tunnel === 'cloudflare'
          ? current.tunnel === 'running'
            ? 'running'
            : 'starting'
          : 'off',
      tunnelError: '',
      publicUrl: config.tunnel === 'cloudflare' ? current.publicUrl : config.publicUrl,
    }));
    void api
      .start(config)
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        if (next.running) {
          // Publish immediately: the server's first visitor should not see an
          // empty share just because the debounced sync has not fired yet.
          void api
            .sync(buildShareSnapshots(sharesRef.current, itemsRef.current))
            .then((after) => {
              if (!cancelled) setStatus(after);
            })
            .catch(() => {});
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setStatus(stoppedStatus(cause instanceof Error ? cause.message : 'Could not start the share server.'));
      });

    return () => {
      cancelled = true;
    };
  }, [active, config.enabled, config.port, config.bind, config.tunnel, config.publicUrl]);

  useEffect(() => {
    const api = getPlatform().share;
    if (!api || !active || !config.enabled) return;
    const timer = setTimeout(() => {
      void api
        .sync(buildShareSnapshots(sharesRef.current, itemsRef.current))
        .then(setStatus)
        .catch((cause) => {
          setStatus(stoppedStatus(cause instanceof Error ? cause.message : 'Could not update the share server.'));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [active, config.enabled, snapshotKey]);

  return status;
}

/**
 * Pulls every linked share on unlock, then every two minutes.
 *
 * The interval deliberately reads items through a ref: applying a result changes
 * `items`, and an effect keyed on the array would tear down and restart the
 * timer after each sync, producing a loop.
 */
export function useLinkedSync(input: {
  active: boolean;
  items: VaultItem[];
  apply: (results: ShareSyncShareResult[]) => Promise<void>;
  onError?: (message: string) => void;
}) {
  const { active, items, apply, onError } = input;
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const itemsRef = useRef(items);
  const applyRef = useRef(apply);
  const errorRef = useRef(onError);
  const busy = useRef(false);
  itemsRef.current = items;
  applyRef.current = apply;
  errorRef.current = onError;

  const syncNow = useCallback(async (manual = false): Promise<number> => {
    const api = getPlatform().share;
    const targets = linkedTargets(itemsRef.current);
    if (targets.length === 0) {
      if (manual) errorRef.current?.('There are no linked shares to sync.');
      return 0;
    }
    if (busy.current) return 0;
    busy.current = true;
    setSyncing(true);
    try {
      const result = api ? await api.syncLinked(targets) : await syncLinkedShares(targets);
      // Include a successful empty snapshot too: the owner may have removed the
      // last login from an otherwise live share, and that must end the copy.
      const touched = result.results.filter(
        (entry) => entry.items.length > 0 || entry.ended || entry.error !== '' || entry.revision > 0,
      );
      if (touched.length > 0) await applyRef.current(touched);
      setLastSyncAt(Date.now());
      return touched.length;
    } catch {
      if (manual) errorRef.current?.('Could not sync shared logins.');
      return 0;
    } finally {
      busy.current = false;
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => void syncNow(false), 2_500);
    const repeat = setInterval(() => void syncNow(false), 120_000);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [active, syncNow]);

  return { syncNow, syncing, lastSyncAt };
}
