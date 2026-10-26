/**
 * Preload bridge: the sole implementation of PlatformAPI (see
 * src/lib/platform.ts) for the desktop shell.
 *
 * Runs with contextIsolation on and sandbox on: no Node APIs, no require —
 * only the electron imports below, which stay available in a sandboxed
 * preload. Everything the renderer needs crosses `contextBridge` as plain
 * data or fire-and-forget invokes. There is deliberately no generic
 * "call main" channel; each capability gets its own whitelisted handler in
 * main.ts, so auditing what the UI can ask the OS to do means reading one
 * short list.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { EfficiencyState, FullMailInput, FullMailResult, InboxListInput, InboxListResult, OAuthConnectInput, OAuthConnectResult, PlatformAPI, RuntimeMemory, ShellSettings, TrayAction } from '../src/lib/platform.ts';
import type {
  ShareRedeemInput,
  ShareRedeemResult,
  ShareServerConfig,
  ShareServerEvent,
  ShareServerStatus,
  ShareSnapshot,
  ShareSyncResult,
  ShareSyncTarget,
} from '../src/lib/shares.ts';
import type {
  TempMailCreateResult,
  TempMailListResult,
  TempMailReadResult,
  TempMailRenewResult,
  TempMailSchedule,
  TempMailScheduleResult,
} from '../src/lib/temp-mail.ts';

declare const COLAX_APP_VERSION: string;

const platform: PlatformAPI = {
  name: 'electron',
  versions: () => ({
    // Baked in by scripts/electron-build.mjs from package.json — no IPC
    // round-trip, so this stays synchronous like the web fallback.
    app: typeof COLAX_APP_VERSION === 'string' ? COLAX_APP_VERSION : 'dev',
    // The Electron version rides in the UA string; no main-process call needed.
    host: `Electron/${navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? 'unknown'}`,
  }),
  openExternal: (url: string) => {
    void ipcRenderer.invoke('colax:open-external', url);
  },
  mail: {
    fetchFullBody: (input: FullMailInput): Promise<FullMailResult> =>
      ipcRenderer.invoke('colax:mail-full', input) as Promise<FullMailResult>,
    listInbox: (input: InboxListInput): Promise<InboxListResult> =>
      ipcRenderer.invoke('colax:mail-list', input) as Promise<InboxListResult>,
  },
  oauth: {
    connect: (input: OAuthConnectInput): Promise<OAuthConnectResult> =>
      ipcRenderer.invoke('colax:oauth-connect', input) as Promise<OAuthConnectResult>,
  },
  tempMail: {
    create: () =>
      ipcRenderer.invoke('colax:temp-mail-create') as Promise<TempMailCreateResult>,
    list: (address: string, sessionKey: string) =>
      ipcRenderer.invoke(
        'colax:temp-mail-list',
        address,
        sessionKey,
      ) as Promise<TempMailListResult>,
    read: (address: string, sessionKey: string, id: string) =>
      ipcRenderer.invoke(
        'colax:temp-mail-read',
        address,
        sessionKey,
        id,
      ) as Promise<TempMailReadResult>,
    renew: (address: string, sessionKey: string) =>
      ipcRenderer.invoke(
        'colax:temp-mail-renew',
        address,
        sessionKey,
      ) as Promise<TempMailRenewResult>,
    syncSchedules: (schedules: TempMailSchedule[]) =>
      ipcRenderer.invoke(
        'colax:temp-mail-sync',
        schedules,
      ) as Promise<TempMailScheduleResult>,
  },
  runtime: {
    setSpellcheck: (enabled: boolean) => {
      void ipcRenderer.invoke('colax:runtime-spellcheck', enabled === true);
    },
    memory: () => ipcRenderer.invoke('colax:runtime-memory') as Promise<RuntimeMemory | null>,
    efficiency: (update?: { maxSavings?: boolean; gpu?: boolean }) =>
      ipcRenderer.invoke('colax:runtime-efficiency', update) as Promise<EfficiencyState>,
  },
  share: {
    start: (config: ShareServerConfig): Promise<ShareServerStatus> =>
      ipcRenderer.invoke('colax:share-start', config) as Promise<ShareServerStatus>,
    stop: (): Promise<ShareServerStatus> =>
      ipcRenderer.invoke('colax:share-stop') as Promise<ShareServerStatus>,
    sync: (snapshots: ShareSnapshot[]): Promise<ShareServerStatus> =>
      ipcRenderer.invoke('colax:share-sync', snapshots) as Promise<ShareServerStatus>,
    status: (): Promise<ShareServerStatus> =>
      ipcRenderer.invoke('colax:share-status') as Promise<ShareServerStatus>,
    redeem: (input: ShareRedeemInput): Promise<ShareRedeemResult> =>
      ipcRenderer.invoke('colax:share-redeem', input) as Promise<ShareRedeemResult>,
    syncLinked: (targets: ShareSyncTarget[]): Promise<ShareSyncResult> =>
      ipcRenderer.invoke('colax:share-sync-linked', targets) as Promise<ShareSyncResult>,
    onEvent: (callback: (event: ShareServerEvent) => void) => {
      const listener = (_event: unknown, payload: ShareServerEvent) => callback(payload);
      ipcRenderer.on('colax:share-event', listener as never);
      return () => {
        ipcRenderer.removeListener('colax:share-event', listener as never);
      };
    },
    onStatus: (callback: (status: ShareServerStatus) => void) => {
      const listener = (_event: unknown, payload: ShareServerStatus) => callback(payload);
      ipcRenderer.on('colax:share-status', listener as never);
      return () => {
        ipcRenderer.removeListener('colax:share-status', listener as never);
      };
    },
  },
  shell: {
    update: (settings: ShellSettings) => {
      void ipcRenderer.invoke('colax:shell-update', settings);
    },
    onTrayAction: (callback: (action: TrayAction) => void) => {
      const listener = (_event: unknown, action: TrayAction) => callback(action);
      ipcRenderer.on('colax:tray-action', listener as never);
      return () => {
        ipcRenderer.removeListener('colax:tray-action', listener as never);
      };
    },
  },
};

contextBridge.exposeInMainWorld('platform', platform);
