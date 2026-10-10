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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ShellSettings } from '../src/lib/platform.ts';
import { closeMailConnections, fetchFullMail, listInboxMail } from './mail-imap.ts';
// Inlined as a data URL by esbuild (see scripts/electron-build.mjs), so the
// tray icon needs no file path that differs between dev and packaged builds.
import trayPng from '../public/colax-icon.png';

const isDev = process.env.ELECTRON_RENDERER_URL !== undefined;
/** Prints per-process memory once the window has loaded, then exits. Diagnostic only. */
const memoryReport = process.argv.includes('--memory-report');
/**
 * Prints whether the window actually painted pixels, then exits.
 *
 * This exists because "the renderer finished loading" and "the user can see the
 * app" turned out to be different claims: a bad GPU switch leaves a window that
 * loads, reports a healthy process tree, and paints nothing but the window's
 * background colour. Anything that changes the rendering path has to be checked
 * with pixels, not with `did-finish-load`.
 */
const renderCheck = process.argv.includes('--render-check');
/** Either diagnostic mode: own profile, no single-instance lock, no splash, exit. */
const diagnostic = memoryReport || renderCheck;

/* ==========================================================================
   Memory switches — read from disk, applied before anything is created
   ==========================================================================

   A Chromium app is several processes, and the figure people compare against
   Task Manager is their sum. Most of that sum is not this app's JavaScript: it
   is Chromium's own baseline (the browser process, a GPU process, and whatever
   renderer processes exist). What can honestly be cut, and is cut here:

   - `SpareRendererForSitePerProcess` is Chromium pre-spawning a whole renderer
     process — tens of megabytes — so that a navigation to another site starts
     instantly. This app loads exactly one document and never navigates, so the
     spare process is pure waste. Disabling it is the largest single saving and
     costs nothing at all.
   - V8's default heap limit is generous, and a heap that is allowed to grow
     grows. Capping old space and the semi-space makes the collector work at a
     size this app actually uses, so peak resident memory comes down without any
     visible difference. It is applied always, not only in low-memory mode,
     because a vault holds kilobytes of data, not megabytes.
   - Low-memory mode (the default, switchable from Settings › Optimize)
     additionally turns on Chromium's low-end-device heuristics — smaller raster
     tiles, smaller image decode caches, no prerender — which trades a little
     smoothness for memory without touching how frames reach the screen.

   The rendering path is where the largest remaining saving is — about 80 MB,
   because the GPU process alone holds that much — and it is also where a change
   can produce a window that loads, reports a healthy process tree, and paints
   nothing. One switch did exactly that in a shipped build. So every switch in
   this area is measured one at a time with `electron . --render-check`, which
   captures the window and reports how many distinct colours it actually
   painted: ~2000 means a UI, single digits mean a blank screen. Nothing here
   ships on the strength of a memory figure alone.

   The file lives in userData rather than in the vault because it has to be
   read *before* the vault exists: preferences live inside the encrypted vault,
   which by definition cannot be opened this early.
   -------------------------------------------------------------------------- */
interface EfficiencySettings {
  maxSavings: boolean;
}

const efficiencyFile = () => join(app.getPath('userData'), 'efficiency.json');

function readEfficiency(): EfficiencySettings {
  try {
    const raw = JSON.parse(readFileSync(efficiencyFile(), 'utf8')) as { maxSavings?: unknown };
    // Absent or malformed means "never touched, or not readable", which takes
    // the lean path: this is an offline vault, the trade costs a little
    // animation smoothness, and it measured ~85 MB smaller. Only an explicit
    // false — the user switching it off again — opts back into the GPU path.
    return { maxSavings: raw?.maxSavings === false ? false : true };
  } catch {
    return { maxSavings: true };
  }
}

function writeEfficiency(next: EfficiencySettings): void {
  const file = efficiencyFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next), 'utf8');
  } catch {
    // A read-only profile keeps the setting for this session only.
  }
}

// Report mode measures a throwaway profile: it must not read or write the
// user's real caches, and it must not fight the running app for the profile
// lock. Declared before anything reads a path.
if (diagnostic) {
  try {
    app.setPath('userData', join(app.getPath('temp'), 'colax-memory-report'));
  } catch {
    // A locked-down temp dir just means the default profile is used instead.
  }
}

const efficiency = readEfficiency();
/**
 * What the running process was actually started with.
 *
 * Compared against the stored setting to answer "will this need a restart"
 * honestly: Chromium has already read its command line, so a toggle flipped now
 * can only take effect on the next launch.
 */
const appliedAtStartup = efficiency.maxSavings;

/**
 * V8 heap caps, in megabytes.
 *
 * Old space is where long-lived objects live; the semi-space is the young
 * generation V8 collects most often. A 192 MB ceiling is far above anything
 * this app allocates (the whole vault is kilobytes) so nothing is ever evicted
 * early, while a runaway allocation is refused instead of ballooning the
 * process. The semi-space cap stops V8 from growing a young generation it never
 * fills.
 */
const HEAP_LIMITS = '--max-old-space-size=192 --max-semi-space-size=8';

/**
 * Chromium features this app never uses, in one comma-separated switch.
 *
 * `appendSwitch('disable-features', …)` replaces rather than appends, so the
 * whole list has to be assembled here — two calls would silently drop the
 * first. Every entry below is a background service a local password vault
 * cannot use:
 *
 *  - SpareRendererForSitePerProcess: a whole pre-spawned renderer process kept
 *    warm so a *navigation* to another site starts instantly. This app loads
 *    one document and never navigates.
 *  - AudioServiceOutOfProcess: a utility process whose only job is sound. The
 *    app's chimes are tiny buffers played from the renderer, and this costs a
 *    process for nothing.
 *  - MediaRouter / DialMediaRouteProvider: Chromecast-style casting.
 *  - AutofillServerCommunication / OptimizationHints: network chatter to
 *    Google, which a zero-network vault must not make anyway.
 *  - Translate, CalculateNativeWinOcclusion: a language translation bar and a
 *    Windows-only occlusion probe, neither reachable from this UI.
 */
const DISABLED_FEATURES = [
  'SpareRendererForSitePerProcess',
  'AudioServiceOutOfProcess',
  'MediaRouter',
  'DialMediaRouteProvider',
  'AutofillServerCommunication',
  'OptimizationHints',
  'Translate',
  'CalculateNativeWinOcclusion',
].join(',');

function applyMemorySwitches(): void {
  app.commandLine.appendSwitch('js-flags', HEAP_LIMITS);
  app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES);
  // No background network at all: no component updates, no crash uploads, no
  // domain reliability beacons, no first-run phone-home. The vault is offline
  // by design, so each of these is a service running for nothing.
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-default-apps');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('metrics-recording-only');
  app.commandLine.appendSwitch('no-first-run');
  app.commandLine.appendSwitch('no-service-autorun');
  if (efficiency.maxSavings) {
    app.commandLine.appendSwitch('enable-low-end-device-mode');
    // Software rasterization: the GPU process is the single largest thing in
    // the tree (~100 MB private), and nothing here needs hardware acceleration.
    // Measured with `--render-check`, one switch at a time, on the machine this
    // was built on:
    //
    //   disable-gpu                  -> 1999 distinct colours painted (fine)
    //   disable-gpu-compositing      -> 1992 distinct colours painted (fine)
    //   force-gpu-mem-available-mb=0 ->    4 distinct colours painted (BLANK)
    //
    // The budget switch is the one that costs the screen: telling Chromium its
    // GPU memory allowance is zero leaves the compositor unable to produce a
    // frame, so the window keeps its background colour and nothing else — while
    // still loading, still reporting a healthy process tree, and still looking
    // like a saving on any memory readout. It is not here, and is banned by
    // test. The other two are safe *because they were measured*, not because
    // they sound safe, and `npm run check:render` is what keeps them honest.
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-features', `${DISABLED_FEATURES},BackForwardCache`);
  }
}

applyMemorySwitches();

/**
 * Per-process memory, the way the OS reports it. kB in, bytes out.
 *
 * `getAppMetrics()` is the only API that sees the whole tree at once, which is
 * why the Optimize panel reports from here rather than from the page's own
 * `performance.memory` — the two agree only when the page's heap happens to be
 * most of the app, and it never is.
 */
function readProcessMemory() {
  try {
    const processes = app.getAppMetrics().map((entry) => ({
      type: entry.type === 'Tab' ? 'Renderer' : entry.type,
      workingSetBytes: Math.max(0, Math.round((entry.memory?.workingSetSize ?? 0) * 1024)),
      privateBytes: Math.max(0, Math.round((entry.memory?.privateBytes ?? 0) * 1024)),
    }));
    return {
      processes,
      totalBytes: processes.reduce((sum, entry) => sum + entry.workingSetBytes, 0),
      /**
       * What the app uniquely holds.
       *
       * Summing working sets counts Chromium's shared read-only pages — V8's
       * snapshot, ICU data, the code itself — once *per process*, so the naive
       * total overstates the app by roughly the size of Chromium. Private bytes
       * do not overlap, which makes this the figure to quote in a memory claim.
       */
      privateTotalBytes: processes.reduce((sum, entry) => sum + entry.privateBytes, 0),
      heapBytes: processes
        .filter((entry) => entry.type === 'Renderer')
        .reduce((sum, entry) => sum + entry.privateBytes, 0),
      maxSavings: efficiency.maxSavings,
      switches: process.argv.filter((arg) => arg.startsWith('--')).join(' '),
    };
  } catch {
    return null;
  }
}

/**
 * Reads what the window actually put on screen.
 *
 * The window is shown first: a hidden window reports no pixels whatever the GPU
 * switches are doing, so capturing one would answer a different question than
 * "can the user see the app". Luminance and the count of near-black pixels are
 * enough to tell a painted UI from a window that never composited, and the
 * renderer's own view of the DOM is reported alongside so the two can only
 * disagree in the informative direction.
 */
async function readPaintedPixels() {
  try {
    const window = mainWindow;
    if (!window) return { error: 'no window' };
    // Read before showing: whether the launch sequence could put this window on
    // screen on its own is exactly the question, and calling show() would erase
    // the evidence.
    const wasVisible = window.isVisible();
    const readyFired = readyToShowFired;
    window.show();
    const dom = (await window.webContents.executeJavaScript(
      `(() => ({
        title: document.title,
        visibleText: (document.body?.innerText ?? '').length,
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      }))()`,
    )) as { title: string; visibleText: number; rootChildren: number };
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const image = await window.webContents.capturePage();
    const bitmap = image.toBitmap();
    const colors = new Set<string>();
    let luminance = 0;
    let nearBlack = 0;
    let pixels = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const blue = bitmap[i] ?? 0;
      const green = bitmap[i + 1] ?? 0;
      const red = bitmap[i + 2] ?? 0;
      luminance += (red * 299 + green * 587 + blue * 114) / 1000;
      if (red < 16 && green < 16 && blue < 16) nearBlack += 1;
      pixels += 1;
      if (pixels % 53 === 0) colors.add(`${red},${green},${blue}`);
    }
    if (pixels === 0) return { ...dom, wasVisible, readyFired, error: 'no pixels captured' };
    return {
      ...dom,
      wasVisible,
      readyFired,
      size: image.getSize(),
      meanLuminance: Math.round((luminance / pixels) * 100) / 100,
      nearBlackFraction: Math.round((nearBlack / pixels) * 1000) / 1000,
      sampledColors: colors.size,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'unknown' };
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shellSettings: ShellSettings = {
  trayEnabled: true,
  closeToTray: true,
  launchAtLogin: false,
  soundsMuted: false,
};

/** Set when Chromium reports the main window's first paint. See createWindow. */
let readyToShowFired = false;

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
  // Skipped in report mode, which is a throwaway measurement that must be able
  // to run while the real app is open — and which uses its own profile dir.
  if (!diagnostic) {
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
  }

  ipcMain.handle('colax:open-external', (_event, url: unknown) => {
    if (typeof url === 'string') void openExternal(url);
  });
  ipcMain.handle('colax:mail-full', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') return { ok: false, error: 'Bad request.' };
      const args = input as {
        address?: unknown;
        appPassword?: unknown;
        feedId?: unknown;
        host?: unknown;
        port?: unknown;
        secure?: unknown;
      };
      if (typeof args.address !== 'string' || typeof args.appPassword !== 'string' || typeof args.feedId !== 'string') {
        return { ok: false, error: 'Bad request.' };
      }
      return await fetchFullMail({
        address: args.address,
        appPassword: args.appPassword,
        feedId: args.feedId,
        host: typeof args.host === 'string' ? args.host : undefined,
        port: typeof args.port === 'number' ? args.port : undefined,
        secure: typeof args.secure === 'boolean' ? args.secure : undefined,
      });
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
      const args = input as {
        address?: unknown;
        appPassword?: unknown;
        host?: unknown;
        port?: unknown;
        secure?: unknown;
        limit?: unknown;
        beforeUid?: unknown;
        query?: unknown;
      };
      if (typeof args.address !== 'string' || typeof args.appPassword !== 'string') {
        return { ok: false, error: 'Bad request.' };
      }
      return await listInboxMail({
        address: args.address,
        appPassword: args.appPassword,
        host: args.host,
        port: args.port,
        secure: args.secure,
        limit: args.limit,
        beforeUid: args.beforeUid,
        query: args.query,
      });
    } catch (cause) {
      return {
        ok: false,
        error: `Mailer error (${cause instanceof Error && cause.message ? cause.message : 'unexpected error'}).`,
      };
    }
  });
  /**
   * The one renderer-driven Chromium knob.
   *
   * Spellcheck is on by default in Electron and loads a hunspell dictionary per
   * detected language. A vault has exactly one place it could matter (the notes
   * box), so the Optimize tab can switch the whole thing off and watch the
   * process tree shrink. Session-scoped, so it applies to this window only.
   */
  ipcMain.handle('colax:runtime-spellcheck', (event, enabled: unknown) => {
    event.sender.session.setSpellCheckerEnabled(enabled === true);
  });
  ipcMain.handle('colax:runtime-memory', () => readProcessMemory());
  /**
   * Reads or writes the pre-start switches.
   *
   * Deliberately not applied live: these are Chromium flags, and Chromium reads
   * its command line once, before any window exists. The answer therefore says
   * whether a restart is needed rather than pretending the change took effect.
   */
  ipcMain.handle('colax:runtime-efficiency', (_event, update: unknown) => {
    if (update && typeof update === 'object' && typeof (update as { maxSavings?: unknown }).maxSavings === 'boolean') {
      const maxSavings = (update as { maxSavings: boolean }).maxSavings;
      efficiency.maxSavings = maxSavings;
      writeEfficiency({ maxSavings });
    }
    return {
      maxSavings: efficiency.maxSavings,
      /** True while the stored setting differs from the one in force. */
      restartRequired: efficiency.maxSavings !== appliedAtStartup,
    };
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
  if (diagnostic) {
    // Measurement mode: no splash (a second window is a second renderer, which
    // would be counted and make the figure meaningless), load, settle, report.
    mainWindow = createWindow();
    // Recorded so --render-check can tell "the launch sequence would have shown
    // this window" from "only an explicit show() can".
    mainWindow.once('ready-to-show', () => {
      readyToShowFired = true;
    });
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          if (memoryReport) {
            console.log('MEMORY_REPORT ' + JSON.stringify(readProcessMemory()));
          }
          if (renderCheck) console.log('RENDER_REPORT ' + JSON.stringify(await readPaintedPixels()));
          app.exit(0);
        })();
      }, 4000);
    });
    return;
  }
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
