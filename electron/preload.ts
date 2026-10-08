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
import type { FullMailInput, FullMailResult, PlatformAPI, ShellSettings, TrayAction } from '../src/lib/platform.ts';

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
