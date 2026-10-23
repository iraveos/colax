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

import type { MailOAuth, OAuthConnectInput, OAuthConnectResult } from './oauth.ts';
import type {
  ShareRedeemInput,
  ShareRedeemResult,
  ShareServerConfig,
  ShareServerEvent,
  ShareServerStatus,
  ShareSnapshot,
  ShareSyncResult,
  ShareSyncTarget,
} from './shares.ts';

export type { OAuthConnectInput, OAuthConnectResult } from './oauth.ts';

/** What the tray menu can ask the renderer to do. Main handles show/restart/quit itself. */
export type TrayAction = 'lock-now' | 'toggle-mute';

/** How to reach one mailbox. Every host is IMAP, so this is all that differs. */
export interface MailConnectionInput {
  /** IMAP hostname. Absent falls back to Google's, for pre-provider callers. */
  host?: string;
  port?: number;
  secure?: boolean;
}

/** One full-body fetch over IMAP. Credentials travel per call, never stored. */
export interface FullMailInput extends MailConnectionInput {
  address: string;
  appPassword: string;
  /** OAuth record for a mailbox signed in without an app password. */
  oauth?: MailOAuth;
  /** Feed message id (`tag:...,2004:<hex>`); the hex tail addresses the mail. */
  feedId: string;
  /** Subject/sender, for the best-effort fallback when the id misses. */
  subject?: string;
  from?: string;
  /**
   * Whether to fetch the message's inline images alongside the body.
   *
   * Defaults to true when absent, so an older caller sees the old behaviour.
   * Optimize → Messages switches it off to skip up to four 512 KB image
   * fetches per opened message — the largest per-message memory saving the
   * app offers. The body and HTML always come back either way.
   */
  images?: boolean;
}

export interface FullMailImage {
  /** Content id, without brackets. Matches `cid:…` references in the HTML. */
  cid: string;
  mime: string;
  /** data: URL, ready for an img src. */
  dataUrl: string;
}

export interface FullMailResult {
  ok: boolean;
  subject?: string;
  from?: string;
  date?: string;
  /** Plain text body, capped. */
  text?: string;
  /** Raw HTML body, when the message carries one. Sanitized in the renderer. */
  html?: string;
  /** Inline images referenced by the HTML, by content id. */
  images?: FullMailImage[];
  error?: string;
}

/** One inbox row listed over IMAP: headers only, no bodies. */
export interface InboxListMessage {
  /** IMAP UID within INBOX. Rows address messages as `imap:<uid>`. */
  uid: number;
  subject: string;
  fromName: string;
  fromAddress: string;
  /** ISO date, possibly empty. */
  date: string;
}

export interface InboxListInput extends MailConnectionInput {
  address: string;
  appPassword: string;
  /** OAuth record for a mailbox signed in without an app password. */
  oauth?: MailOAuth;
  limit?: number;
  /**
   * Page back past this UID.
   *
   * The first page is the newest `limit` messages; passing the oldest UID seen
   * so far returns the next `limit` *older* ones, which is what makes the list
   * unlimited: no single read has a ceiling, the list just grows as far back as
   * the user asks to scroll.
   */
  beforeUid?: number;
  /** Server-side search across subject, sender, recipient and body. */
  query?: string;
}

export interface InboxListResult {
  ok: boolean;
  messages?: InboxListMessage[];
  /** True when older messages exist past this page. */
  hasMore?: boolean;
  error?: string;
}

/** One process's share of the app's memory, as the OS reports it. */
export interface ProcessMemory {
  /** 'Browser', 'Renderer', 'GPU', 'Utility', or a named utility process. */
  type: string;
  /** Working set — what the OS task manager calls "Memory". */
  workingSetBytes: number;
  /** Private bytes: the part this process does not share with the others. */
  privateBytes: number;
}

/**
 * Where the app's memory actually went.
 *
 * A Chromium app is several processes and the number people notice in Task
 * Manager is the sum of all of them, which is why "the vault is using 400 MB"
 * and "the vault's JavaScript heap is 40 MB" are both true at once. Reporting
 * the split is the only honest way to answer "why so much, and did optimising
 * help".
 */
export interface RuntimeMemory {
  processes: ProcessMemory[];
  /**
   * Sum of every process's working set — the figure a task manager shows.
   *
   * Chromium's shared read-only pages are counted once per process here, so this
   * is always larger than what the app uniquely holds. Quote
   * {@link privateTotalBytes} for a memory claim, and this one for "what you
   * will see in Task Manager".
   */
  totalBytes: number;
  /** Sum of every process's private bytes: what the app uniquely holds. */
  privateTotalBytes: number;
  /** Sum of the JavaScript heaps the renderers report. */
  heapBytes: number;
}

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
   * Full message bodies over IMAP. Absent on web — a browser page cannot open
   * a socket — so call sites must tolerate undefined and hide the affordance.
   */
  mail?: {
    /** Fetches one message's complete plain-text body in the main process. */
    fetchFullBody(input: FullMailInput): Promise<FullMailResult>;
    /** Lists recent unread headers over IMAP. The feed fallback when Atom fails. */
    listInbox(input: InboxListInput): Promise<InboxListResult>;
  };
  /**
   * OAuth2 sign-in for a mailbox. Absent on web — the flow needs a loopback
   * server and the real browser, neither of which a served page can have —
   * so call sites feature-check and say the desktop app is needed.
   */
  oauth?: {
    /**
     * Runs the authorization-code flow: opens the provider in the real
     * browser, catches the redirect on 127.0.0.1, and returns the tokens.
     * The PKCE exchange happens entirely in the main process.
     */
    connect(input: OAuthConnectInput): Promise<OAuthConnectResult>;
  };
  /**
   * Sharing between Colax installs.
   *
   * Absent on web — a browser tab cannot listen on a socket, and it cannot fetch
   * a LAN address without CORS — so every call site feature-checks and explains
   * that the desktop app is needed.
   */
  share?: {
    /** Starts, or reconfigures, the local share server. */
    start(config: ShareServerConfig): Promise<ShareServerStatus>;
    stop(): Promise<ShareServerStatus>;
    /** Replaces the in-memory snapshot the server may serve. */
    sync(snapshots: ShareSnapshot[]): Promise<ShareServerStatus>;
    status(): Promise<ShareServerStatus>;
    /** Redeems a code against another device's server. */
    redeem(input: ShareRedeemInput): Promise<ShareRedeemResult>;
    /** Pulls updates for every linked copy, from each owner's server. */
    syncLinked(targets: ShareSyncTarget[]): Promise<ShareSyncResult>;
    /** Live device/access events from this device's own server. */
    onEvent(callback: (event: ShareServerEvent) => void): () => void;
    /** Tunnel/server status changes that happen outside an IPC call. */
    onStatus(callback: (status: ShareServerStatus) => void): () => void;
  };
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
  /**
   * Desktop-only runtime knobs and measurements. Absent on web — there is no
   * spellchecker to switch off and no multi-process tree to measure — so call
   * sites must feature-check before using it.
   */
  runtime?: {
    /**
     * Turns Chromium's built-in spellchecker on or off.
     *
     * Electron enables it by default, and it loads a hunspell dictionary per
     * language at startup — tens of megabytes of tables that a password vault
     * only ever needs for the notes field. Switching it off is one of the few
     * optimisations here that moves a number the user can see.
     */
    setSpellcheck(enabled: boolean): void;
    /** Per-process memory for the whole app, or null when unavailable. */
    memory(): Promise<RuntimeMemory | null>;
    /**
     * Reads, or writes, the switches Chromium needs at launch.
     *
     * These cannot be applied while the app is running — Chromium reads its
     * command line before any window exists — so the answer includes whether a
     * restart is required rather than implying the change is live.
     */
    efficiency(update?: { maxSavings?: boolean; gpu?: boolean }): Promise<EfficiencyState>;
  };
}

/** The launch-time memory switches, and whether they are in force yet. */
export interface EfficiencyState {
  /** Chromium's low-end-device heuristics: smaller raster tiles and image caches. */
  maxSavings: boolean;
  /**
   * Whether the GPU composites frames. Off means software rasterization: about
   * 80 MB less memory, and the processor cost of drawing every frame.
   */
  gpu: boolean;
  /** True while a stored setting differs from the running process. */
  restartRequired: boolean;
}

declare global {
  interface Window {
    platform?: PlatformAPI;
  }
}

/** Baked by vite at build time (see vite.config.ts). Absent under tests and dev. */
declare const __COLAX_BUILD__: string | undefined;

/**
 * Which exact build is running, e.g. "1.0.0 · built 2026-10-08 08:49 UTC".
 * Shown in Settings so a stale install is identifiable on sight rather than
 * arguable. Falls back to 'dev' wherever the define never ran.
 */
export function buildStamp(): string {
  return typeof __COLAX_BUILD__ === 'string' && __COLAX_BUILD__ ? __COLAX_BUILD__ : 'dev';
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
