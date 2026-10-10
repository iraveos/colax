/**
 * Electron main process: window shell only.
 *
 * Nothing about the vault lives here — no items, no crypto, no preferences.
 * This file creates a window, loads the renderer, owns the tray icon and the
 * splash screen, and answers the handful of IPC calls the preload bridge
 * exposes. If it grows beyond that, something that belongs in src/ or in the
 * preload bridge has leaked in.
 *
 * Bundled by scripts/electron-build.mjs (esbuild, CJS) — never run through
 * tsconfig.app.json, which is the renderer project.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import type { ShellSettings } from '../src/lib/platform.ts';
import { closeMailConnections, fetchFullMail, listInboxMail } from './mail-imap.ts';
// Inlined as a data URL by esbuild (see scripts/electron-build.mjs), so the
// tray icon needs no file path that differs between dev and packaged builds.
import trayPng from '../public/colax-icon.png';

const isDev = process.env.ELECTRON_RENDERER_URL !== undefined;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shellSettings: ShellSettings = {
  trayEnabled: true,
  closeToTray: true,
  launchAtLogin: false,
  soundsMuted: false,
};

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#10141c',
    // Dev only: the packaged exe carries the icon from electron-builder.
    ...(isDev ? { icon: join(__dirname, '..', 'public', 'colax-icon.png') } : {}),
    // Hidden until ready: the splash covers the load, then this fades in.
    show: false,
    webPreferences: {
      // __dirname is dist-electron/ both bundled and in dev.
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string);
  } else {
    // Packaged layout: <app>/resources/dist/index.html.
    void window.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  // Belt and braces with the preload bridge: even if some renderer code calls
  // window.open directly, it opens in the OS browser instead of spawning a
  // second, chromeless app window holding the unlocked vault.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  // Console on F12 (and Ctrl+Shift+I, the muscle memory from every browser).
  // Deliberately always on, dev and packaged alike: this is the owner's vault
  // on the owner's machine, and hiding the tools would only slow down the
  // person maintaining it.
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.control && input.shift)) {
      if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
      else window.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // X means "hide to tray" when configured, not "quit". The tray's Quit and
  // Restart set `quitting` first so they still terminate.
  window.on('close', (event) => {
    if (!quitting && shellSettings.trayEnabled && shellSettings.closeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

/** Only http(s) may leave the app, and only via the OS browser. */
async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  await shell.openExternal(parsed.toString());
}

function sendToRenderer(channel: 'colax:tray-action', action: string): void {
  mainWindow?.webContents.send(channel, action);
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const muted = shellSettings.soundsMuted;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Colax', click: () => mainWindow?.show() },
      { label: 'Lock vault now', click: () => sendToRenderer('colax:tray-action', 'lock-now') },
      {
        label: muted ? 'Unmute sounds' : 'Mute sounds',
        click: () => sendToRenderer('colax:tray-action', 'toggle-mute'),
      },
      { type: 'separator' },
      {
        label: 'Restart',
        click: () => {
          quitting = true;
          app.relaunch();
          app.quit();
        },
      },
      {
        label: 'Quit Colax',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(`Colax${muted ? ' (muted)' : ''}`);
}

function applyShellSettings(next: ShellSettings): void {
  shellSettings = { ...next };
  // Autostart. openAtLogin is all Squirrel/NSIS installs need; args stay empty
  // so a login start opens the normal window rather than a hidden one.
  app.setLoginItemSettings({ openAtLogin: shellSettings.launchAtLogin });
  if (shellSettings.trayEnabled && !tray) {
    tray = new Tray(nativeImage.createFromDataURL(trayPng));
    tray.setToolTip('Colax');
    // Left-click toggles, right-click takes the menu. One gesture each, so
    // neither hides behind the other.
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } else if (!shellSettings.trayEnabled && tray) {
    tray.destroy();
    tray = null;
  }
  rebuildTrayMenu();
}

/**
 * Launch splash: a frameless window shown instantly while the real window
 * loads the renderer. Self-contained data URL — no file to package, no path
 * that differs between dev and installed builds. Dismissed on ready-to-show
 * with a floor on display time, so a fast machine still perceives the brand
 * rather than a flicker.
 */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 380,
    height: 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;box-sizing:border-box}
    body{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(120% 120% at 50% 0%,#1a2233 0%,#10141c 60%,#0b0e14 100%);border-radius:22px;overflow:hidden;font-family:system-ui,sans-serif;color:#e8ecf4;animation:rise .5s ease-out both;user-select:none;-webkit-app-region:drag}
    @keyframes rise{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
    .mark{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:grid;place-items:center;box-shadow:0 12px 40px -8px #3b82f680,inset 0 1px #ffffff40;animation:pulse 1.6s ease-in-out infinite}
    @keyframes pulse{50%{transform:scale(1.05);box-shadow:0 12px 48px -6px #8b5cf690,inset 0 1px #ffffff40}}
    .name{font-size:22px;font-weight:650;letter-spacing:-.02em}
    .sub{font-size:12px;color:#8b93a7;letter-spacing:.14em;text-transform:uppercase}
    .bar{width:180px;height:4px;border-radius:2px;background:#ffffff14;overflow:hidden}
    .bar i{display:block;height:100%;width:40%;border-radius:2px;background:linear-gradient(90deg,#3b82f6,#8b5cf6);animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(450%)}}
  </style></head><body>
    <div class="mark"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>
    <div class="name">Colax</div>
    <div class="sub">Unlocking your vault</div>
    <div class="bar"><i></i></div>
  </body></html>`;
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

void app.whenReady().then(() => {
  // One vault, one writer. A second instance would open its own IndexedDB
  // handle against the same profile and the two copies would silently diverge.
  const single = app.requestSingleInstanceLock();
  if (!single) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    // A second launch focuses the running vault instead of opening another.
    mainWindow?.show();
    mainWindow?.focus();
  });

  ipcMain.handle('colax:open-external', (_event, url: unknown) => {
    if (typeof url === 'string') void openExternal(url);
  });
  ipcMain.handle('colax:mail-full', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') return { ok: false, error: 'Bad request.' };
      const args = input as { address?: unknown; appPassword?: unknown; feedId?: unknown };
      if (typeof args.address !== 'string' || typeof args.appPassword !== 'string' || typeof args.feedId !== 'string') {
        return { ok: false, error: 'Bad request.' };
      }
      return await fetchFullMail({ address: args.address, appPassword: args.appPassword, feedId: args.feedId });
    } catch (cause) {
      return {
        ok: false,
        error: `Mailer error (${cause instanceof Error && cause.message ? cause.message : 'unexpected error'}). Open it in Gmail instead.`,
      };
    }
  });
  ipcMain.handle('colax:mail-list', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') return { ok: false, error: 'Bad request.' };
      const args = input as { address?: unknown; appPassword?: unknown; limit?: unknown };
      if (typeof args.address !== 'string' || typeof args.appPassword !== 'string') {
        return { ok: false, error: 'Bad request.' };
      }
      return await listInboxMail({ address: args.address, appPassword: args.appPassword, limit: args.limit });
    } catch (cause) {
      return {
        ok: false,
        error: `Mailer error (${cause instanceof Error && cause.message ? cause.message : 'unexpected error'}).`,
      };
    }
  });
  ipcMain.handle('colax:shell-update', (_event, settings: unknown) => {
    if (!settings || typeof settings !== 'object') return;
    const next = settings as Partial<ShellSettings>;
    applyShellSettings({
      trayEnabled: next.trayEnabled !== false,
      closeToTray: next.closeToTray !== false,
      launchAtLogin: next.launchAtLogin === true,
      soundsMuted: next.soundsMuted === true,
    });
  });

  const shownAt = Date.now();
  const splash = createSplash();
  mainWindow = createWindow();
  mainWindow.once('ready-to-show', () => {
    // Floor the splash so a fast load still reads as a launch, not a flicker.
    const wait = Math.max(0, 700 - (Date.now() - shownAt));
    setTimeout(() => {
      splash.close();
      mainWindow?.show();
      mainWindow?.focus();
    }, wait);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Mailbox connections are persistent now: log them out on quit instead of
// leaving Gmail sessions dangling until they time out server-side.
app.on('before-quit', () => {
  void closeMailConnections();
});
