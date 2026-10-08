/**
 * Platform seam: the only desktop capability the UI may touch.
 *
 * Rule, enforced by convention and code review: nothing under src/ imports
 * Electron (or Tauri, or Capacitor) directly. Every native capability the app
 * needs goes on `PlatformAPI` here, with a web fallback, and each shell
 * (electron/preload.ts today, something else tomorrow) provides the real
 * implementation over the same shape. Switching shells later means writing a
 * second implementation of this interface — the UI does not change.
 *
 * Deliberately tiny. Add a method only when the web platform genuinely cannot
 * do the job; everything else stays a web API call at the call site.
 */

/** What the tray menu can ask the renderer to do. Main handles show/restart/quit itself. */
export type TrayAction = 'lock-now' | 'toggle-mute';

/** Desktop window-chrome settings, mirrored from prefs. */
export interface ShellSettings {
  trayEnabled: boolean;
  closeToTray: boolean;
  launchAtLogin: boolean;
  /** Included so the tray menu labels itself correctly (Mute/Unmute). */
  soundsMuted: boolean;
}

export interface PlatformAPI {
  /** 'electron' inside the desktop shell, 'web' everywhere else. */
  readonly name: 'electron' | 'web';
  /** Human-readable host versions, for the About screen and bug reports. */
  versions(): { app: string; host: string };
  /**
   * Open a URL in the user's real browser.
   *
   * `window.open(url, '_blank')` inside Electron spawns a second app window,
   * which is the opposite of what "Open site" means. The shell routes this to
   * the OS browser; the web fallback keeps the old behavior.
   */
  openExternal(url: string): void;
  /**
   * Desktop shell controls. Absent on web — there is no tray, autostart or
   * window chrome to manage there, so call sites must tolerate undefined.
   */
  shell?: {
    /** Push window-chrome settings to the shell; the shell applies tray, autostart and close behavior. */
    update(settings: ShellSettings): void;
    /** Tray menu events the shell cannot handle alone (lock, mute). Returns an unsubscribe. */
    onTrayAction(callback: (action: TrayAction) => void): () => void;
  };
}

declare global {
  interface Window {
    platform?: PlatformAPI;
  }
}

const webPlatform: PlatformAPI = {
  name: 'web',
  versions: () => ({
    app: 'colax-web',
    host: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
  }),
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener');
  },
};

/**
 * The platform for this runtime. Safe to call anywhere, including tests and
 * SSR-ish contexts: with no `window` at all it returns the web fallback rather
 * than throwing, so capability checks never need their own guards.
 */
export function getPlatform(): PlatformAPI {
  if (typeof window === 'undefined') return webPlatform;
  return window.platform ?? webPlatform;
}
