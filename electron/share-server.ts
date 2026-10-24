/**
 * A tiny, local-only share server.
 *
 * It is deliberately not a general web server. There are exactly five routes,
 * every response is generated HTML, and the only login data it ever holds is the
 * snapshot the unlocked renderer sends over IPC. Lock the vault or quit the app
 * and the server is stopped; nothing is written to disk by this module.
 *
 * Security posture:
 *   - binds 127.0.0.1 unless the user explicitly chooses LAN
 *   - short codes are stored only as SHA-256 hashes in the renderer and re-hashed
 *     here for lookup
 *   - PINs are PBKDF2-HMAC-SHA-256, 210k iterations
 *   - device tokens are random 32-byte values, stored only as hashes
 *   - per-IP rate limiting on code redemption and PIN entry
 *   - strict CSP, no scripts, no CORS, no directory traversal, escaped output
 *   - browser sessions for PIN shares are in-memory and expire
 */

import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import {
  normaliseShareCode,
  type ShareAccess,
  type ShareAccessAction,
  type ShareDevice,
  type ShareServerConfig,
  type ShareServerEvent,
  type ShareServerStatus,
  type ShareSnapshot,
  type SharedLogin,
  type VaultShare,
} from '../src/lib/shares.ts';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const PREAUTH_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_PREAUTH = 500;
const MAX_DEVICES = 50;
const MAX_ACCESS = 250;
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LOCK_MS = 15 * 60 * 1000;

interface BrowserSession {
  shareId: string;
  expiresAt: number;
}

interface PreAuth {
  shareId: string;
  csrf: string;
  expiresAt: number;
}

interface Attempt {
  fails: number;
  firstAt: number;
  lockedUntil: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenHash(value: string): string {
  return sha256Hex(value);
}

function randomId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : '';
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
    : '';
}

function cleanImage(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > max) return '';
  return /^data:image\//i.test(text) || /^https?:\/\//i.test(text) ? text : '';
}

function cleanLogin(raw: SharedLogin): SharedLogin {
  return {
    id: clean(raw?.id, 100),
    title: clean(raw?.title, 180) || 'Untitled login',
    username: clean(raw?.username, 300),
    password: typeof raw?.password === 'string' ? raw.password.slice(0, 4000) : '',
    url: clean(raw?.url, 1000),
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 40_000) : '',
    totpSecret: typeof raw?.totpSecret === 'string' ? raw.totpSecret.slice(0, 400) : '',
    attachments: Array.isArray(raw?.attachments)
      ? raw.attachments
          .slice(0, 12)
          .filter(
            (entry) =>
              entry &&
              typeof entry.id === 'string' &&
              typeof entry.mime === 'string' &&
              typeof entry.dataUrl === 'string' &&
              entry.dataUrl.startsWith(`data:${entry.mime};base64,`),
          )
          .map((entry) => ({
            id: entry.id.slice(0, 100),
            name: clean(entry.name, 200),
            mime: entry.mime.slice(0, 160),
            dataUrl: entry.dataUrl,
          }))
      : [],
    accentHue:
      typeof raw?.accentHue === 'number' && Number.isFinite(raw.accentHue)
        ? ((Math.round(raw.accentHue) % 360) + 360) % 360
        : null,
    backgroundImage: cleanImage(raw?.backgroundImage, 8_000_000),
    backgroundBlur:
      typeof raw?.backgroundBlur === 'number' && Number.isFinite(raw.backgroundBlur)
        ? Math.max(0, Math.min(60, raw.backgroundBlur))
        : 0,
    avatarImage: cleanImage(raw?.avatarImage, 2_000_000),
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function cleanShare(share: VaultShare): VaultShare {
  return {
    ...share,
    name: clean(share.name, 120) || 'Shared logins',
    codeHash: clean(share.codeHash, 128),
    pinHash: clean(share.pinHash, 256),
    pinSalt: clean(share.pinSalt, 128),
    itemIds: Array.isArray(share.itemIds)
      ? [...new Set(share.itemIds.filter((id): id is string => typeof id === 'string'))].slice(0, 500)
      : [],
    devices: Array.isArray(share.devices) ? share.devices.slice(0, MAX_DEVICES) : [],
    access: Array.isArray(share.access) ? share.access.slice(0, MAX_ACCESS) : [],
  };
}

/** A device identity is kept in the server's in-memory copy as well as reported. */
function makeAccess(
  share: VaultShare,
  action: ShareAccessAction,
  req: IncomingMessage,
  device: ShareDevice | null,
  item?: SharedLogin,
): ShareAccess {
  return {
    id: `sa_${randomId(9)}`,
    at: Date.now(),
    action,
    deviceId: device?.id ?? '',
    deviceName: device?.name ?? (action === 'view' || action === 'open-login' ? 'Browser' : ''),
    ip: requestIp(req),
    userAgent: clean(req.headers['user-agent'], 300),
    itemId: item?.id ?? '',
    // The title lives in the encrypted vault; preferences are plaintext. The
    // activity row resolves the id against the unlocked items instead of
    // copying a login name into a share log that outlives the lock.
    itemTitle: '',
  };
}

function requestIp(req: IncomingMessage): string {
  // A tunnel terminates every connection on loopback, so using only
  // `socket.remoteAddress` would make all recipients share one rate-limit
  // bucket and let one person's failed PINs lock everyone out. Prefer the
  // proxy's client address; a direct-LAN client could forge it to dodge the
  // limiter, but the PIN's PBKDF2 cost still stands between them and the share.
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return clean(forwarded.split(',')[0], 80) || 'unknown';
  }
  return clean(req.socket.remoteAddress, 80) || 'unknown';
}

function isHttps(req: IncomingMessage): boolean {
  return clean(req.headers['x-forwarded-proto'], 20).split(',')[0]?.trim() === 'https';
}

function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  options: { path: string; maxAge: number; https: boolean },
): void {
  const bits = [
    `${name}=${value}`,
    `Path=${options.path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAge / 1000))}`,
  ];
  if (options.https) bits.push('Secure');
  const previous = res.getHeader('Set-Cookie');
  const list = Array.isArray(previous) ? previous : previous ? [String(previous)] : [];
  res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
}

function readCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function appCors(res: ServerResponse): void {
  // The desktop app has no Origin, while a browser-hosted Colax tab does. The
  // code and device token are the authentication, so letting a cross-origin
  // fetch reach these two JSON endpoints does not widen who can read a share.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  securityHeaders(res);
  appCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Reads a capped body, whether urlencoded or JSON. */
async function readBody(req: IncomingMessage): Promise<{ text: string; json: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    json: String(req.headers['content-type'] ?? '').includes('application/json'),
  };
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · Colax</title>
<style>
:root{color-scheme:dark light;--bg:#10131a;--panel:#171c26;--text:#eef2f8;--muted:#9aa6ba;--line:#2b3444;--accent:#7aa2ff;--danger:#ff8d8d}
@media (prefers-color-scheme:light){:root{--bg:#f4f6fb;--panel:#fff;--text:#172033;--muted:#647087;--line:#dbe2ee;--accent:#2e5bd3;--danger:#b42323}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
body{padding:28px 18px 48px}
main{max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent)}
h1{font-size:clamp(24px,5vw,34px);line-height:1.15;margin:0 0 6px}
p{margin:8px 0;color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;margin:18px 0;box-shadow:0 12px 40px rgba(0,0,0,.12)}
a{color:var(--accent)}
.row{display:block;padding:14px 0;border-top:1px solid var(--line);text-decoration:none;color:var(--text)}
.row:first-of-type{border-top:0;padding-top:0}
.row strong{display:block;font-size:16px}
.row span{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;letter-spacing:.12em}
button{padding:11px 16px;border-radius:10px;border:0;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin-top:12px}
button:disabled{opacity:.5;cursor:default}
code{font-family:ui-monospace,Consolas,monospace;background:color-mix(in srgb,var(--line) 45%,transparent);padding:2px 6px;border-radius:6px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--text);font:inherit}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 16px;margin:0}
dt{color:var(--muted);font-size:13px}
dd{margin:0;overflow-wrap:anywhere}
.error{color:var(--danger)}
details{margin-top:12px}
summary{cursor:pointer;color:var(--accent)}
.notes{white-space:pre-wrap;overflow-wrap:anywhere}
.attachments a{display:block;margin:6px 0}
.footer{color:var(--muted);font-size:12px;margin-top:22px}
</style>
</head>
<body><main>
<div class="brand"><span class="dot"></span>Colax share</div>
${body}
<div class="footer">This page was served from the owner's device. Nothing is stored on a central server.</div>
</main></body></html>`;
}

function errorPage(status: number, title: string, text: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><div class="panel"><p>${escapeHtml(text)}</p></div>`);
}

function pinPage(code: string, csrf: string, name: string, error = ''): string {
  return page(
    'Enter PIN',
    `<h1>${escapeHtml(name)}</h1>
<div class="panel">
<p>This share is protected by a PIN. Enter it to see the logins.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/s/${escapeHtml(code)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="pin">PIN</label>
<input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="12" required autofocus>
<button type="submit">Open share</button>
</form>
</div>`,
  );
}

function loginListPage(code: string, share: VaultShare, items: SharedLogin[]): string {
  const rows = items.length
    ? items
        .map(
          (item) => `<a class="row" href="/s/${escapeHtml(code)}/logins/${encodeURIComponent(item.id)}">
<strong>${escapeHtml(item.title)}</strong>
<span>${escapeHtml(item.username || item.url || 'No username')}</span>
</a>`,
        )
        .join('')
    : '<p>No logins are in this share yet.</p>';
  return page(
    share.name,
    `<h1>${escapeHtml(share.name)}</h1>
<p>${items.length} login${items.length === 1 ? '' : 's'} shared from the owner's vault. Changes made by the owner appear here on the next sync.</p>
<div class="panel">${rows}</div>`,
  );
}

function loginPage(code: string, share: VaultShare, item: SharedLogin): string {
  const url = safeUrl(item.url);
  const attachments = item.attachments.length
    ? `<div class="attachments">${item.attachments
        .map(
          (attachment) =>
            `<a href="${escapeHtml(attachment.dataUrl)}" download="${escapeHtml(attachment.name || 'attachment')}">${escapeHtml(attachment.name || attachment.mime)}</a>`,
        )
        .join('')}</div>`
    : '';
  return page(
    item.title,
    `<p><a href="/s/${escapeHtml(code)}">← ${escapeHtml(share.name)}</a></p>
<h1>${escapeHtml(item.title)}</h1>
<div class="panel">
<dl>
<dt>Username</dt><dd>${escapeHtml(item.username || '—')}</dd>
<dt>Password</dt><dd><details><summary>Show password</summary><code>${escapeHtml(item.password || '—')}</code></details></dd>
<dt>Website</dt><dd>${url ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(item.url)}</a>` : escapeHtml(item.url || '—')}</dd>
${item.totpSecret ? `<dt>2FA seed</dt><dd><details><summary>Show seed</summary><code>${escapeHtml(item.totpSecret)}</code></details></dd>` : ''}
</dl>
${item.notes ? `<h2>Notes</h2><div class="notes">${escapeHtml(item.notes)}</div>` : ''}
${attachments}
</div>`,
  );
}

/**
 * Owns one HTTP listener and the in-memory snapshot it serves.
 *
 * Main creates exactly one for the process. Tests create throwaway instances on
 * port 0.
 */
export class ShareServer {
  #server: Server | null = null;
  #config: ShareServerConfig | null = null;
  #status: ShareServerStatus = {
    running: false,
    port: 0,
    host: '',
    hostName: hostname(),
    localUrl: '',
    publicUrl: '',
    error: '',
    tunnel: 'off',
    tunnelError: '',
  };
  #snapshots = new Map<string, ShareSnapshot>();
  #sessions = new Map<string, BrowserSession>();
  #preauth = new Map<string, PreAuth>();
  #attempts = new Map<string, Attempt>();
  #onEvent: (event: ShareServerEvent) => void;

  constructor(onEvent: (event: ShareServerEvent) => void = () => {}) {
    this.#onEvent = onEvent;
  }

  status(): ShareServerStatus {
    return { ...this.#status };
  }

  async start(config: ShareServerConfig): Promise<ShareServerStatus> {
    const port = Number.isFinite(config.port) ? Math.round(config.port) : 47821;
    if (port < 0 || port > 65535) {
      this.#status = { ...this.#status, running: false, error: 'Port must be between 1024 and 65535.' };
      return this.status();
    }
    if (this.#server && this.#config && this.#config.port === port && this.#config.bind === config.bind) {
      this.#config = { ...config, port };
      this.#status = {
        ...this.#status,
        publicUrl: clean(config.publicUrl, 500),
      };
      return this.status();
    }
    await this.stop();
    const host = config.bind === 'lan' ? '0.0.0.0' : '127.0.0.1';
    this.#config = { ...config, port };
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((cause) => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: cause instanceof Error ? cause.message : 'Server error.' });
        } else {
          res.end();
        }
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (cause: Error) => {
          server.removeListener('listening', ok);
          reject(cause);
        };
        const ok = () => {
          server.removeListener('error', fail);
          resolve();
        };
        server.once('error', fail);
        server.once('listening', ok);
        server.listen(port, host);
      });
    } catch (cause) {
      this.#server = null;
      this.#status = {
        running: false,
        port,
        host,
        hostName: this.#status.hostName,
        localUrl: '',
        publicUrl: clean(config.publicUrl, 500),
        error:
          cause instanceof Error && 'code' in cause && cause.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Choose another port.`
            : cause instanceof Error
              ? cause.message
              : 'Could not start the share server.',
        tunnel: 'off',
        tunnelError: '',
      };
      return this.status();
    }

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const localHost = config.bind === 'lan' ? lanAddress() : '127.0.0.1';
    this.#status = {
      running: true,
      port: actualPort,
      host,
      hostName: this.#status.hostName,
      localUrl: `http://${localHost}:${actualPort}`,
      publicUrl: clean(config.publicUrl, 500),
      error: '',
      tunnel: 'off',
      tunnelError: '',
    };
    return this.status();
  }

  async stop(): Promise<ShareServerStatus> {
    const server = this.#server;
    this.#server = null;
    this.#config = null;
    this.#snapshots.clear();
    this.#sessions.clear();
    this.#preauth.clear();
    this.#attempts.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    this.#status = {
      running: false,
      port: this.#status.port,
      host: this.#status.host,
      hostName: this.#status.hostName,
      localUrl: '',
      publicUrl: this.#status.publicUrl,
      error: '',
      tunnel: 'off',
      tunnelError: '',
    };
    return this.status();
  }

  /** Replaces the snapshot wholesale. Called after an edit or an unlock. */
  sync(snapshots: ShareSnapshot[]): ShareServerStatus {
    const next = new Map<string, ShareSnapshot>();
    for (const candidate of Array.isArray(snapshots) ? snapshots : []) {
      if (!candidate || typeof candidate !== 'object' || !candidate.share) continue;
      const share = cleanShare(candidate.share);
      if (!share.id || !share.codeHash) continue;
      const items = Array.isArray(candidate.items)
        ? candidate.items.map(cleanLogin).filter((item) => item.id)
        : [];
      next.set(share.id, { share, items });
    }
    // Preserve devices and uses the server learned about between the renderer's
    // last preference write and this sync, so a fast edit cannot un-enrol a
    // device that redeemed a moment earlier.
    for (const [id, incoming] of next) {
      const current = this.#snapshots.get(id);
      if (!current) continue;
      // A newer rule set is authoritative. That is what lets "New code" clear
      // the old devices and reset the use count; an older snapshot, or an
      // unchanged one travelling with an event-driven preferences write, is
      // merged so it cannot un-pair a device that redeemed seconds ago.
      const authoritative =
        incoming.share.updatedAt > current.share.updatedAt ||
        incoming.share.codeHash !== current.share.codeHash;
      if (!authoritative) {
        const incomingById = new Map(incoming.share.devices.map((device) => [device.id, device]));
        for (const device of current.share.devices) {
          const known = incomingById.get(device.id);
          // A re-pair rotates the token for the same device id. If the renderer
          // has not received that event yet, its snapshot carries the old hash;
          // keep whichever record was created or seen most recently.
          if (
            !known ||
            device.createdAt > known.createdAt ||
            device.lastSeenAt > known.lastSeenAt
          ) {
            incomingById.set(device.id, device);
          }
        }
        incoming.share.devices = [...incomingById.values()]
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-MAX_DEVICES);
        incoming.share.uses = Math.max(incoming.share.uses, current.share.uses);
      }
      const known = new Set(incoming.share.access.map((entry) => entry.id));
      incoming.share.access = [
        ...current.share.access.filter((entry) => !known.has(entry.id)),
        ...incoming.share.access,
      ].slice(0, MAX_ACCESS);
    }
    this.#snapshots = next;
    this.#cleanup();
    return this.status();
  }

  #findByCode(code: string): ShareSnapshot | null {
    const hash = sha256Hex(normaliseShareCode(code));
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.share.codeHash === hash) return snapshot;
    }
    return null;
  }

  #findByToken(code: string, token: string): { snapshot: ShareSnapshot; device: ShareDevice } | null {
    const snapshot = this.#findByCode(code);
    if (!snapshot || !token) return null;
    const hash = tokenHash(token);
    const device = snapshot.share.devices.find(
      (entry) => entry.revokedAt === null && timingSafeEqualHex(entry.tokenHash, hash),
    );
    return device ? { snapshot, device } : null;
  }

  #sessionFor(req: IncomingMessage, shareId: string): BrowserSession | null {
    const sid = readCookies(req).colax_share;
    if (!sid) return null;
    const session = this.#sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt <= Date.now() || session.shareId !== shareId) {
      this.#sessions.delete(sid);
      return null;
    }
    return session;
  }

  #makeSession(res: ServerResponse, req: IncomingMessage, shareId: string, path: string): void {
    const sid = randomId(24);
    this.#sessions.set(sid, { shareId, expiresAt: Date.now() + SESSION_MS });
    setCookie(res, 'colax_share', sid, {
      path,
      maxAge: SESSION_MS,
      https: isHttps(req),
    });
  }

  #makePreauth(res: ServerResponse, req: IncomingMessage, shareId: string, path: string): string {
    const id = randomId(18);
    const csrf = randomId(24);
    this.#preauth.set(id, { shareId, csrf, expiresAt: Date.now() + PREAUTH_MS });
    setCookie(res, 'colax_gate', id, {
      path,
      maxAge: PREAUTH_MS,
      https: isHttps(req),
    });
    return csrf;
  }

  #allow(key: string): boolean {
    const attempt = this.#attempts.get(key);
    if (!attempt) return true;
    const now = Date.now();
    if (attempt.lockedUntil > now) return false;
    if (now - attempt.firstAt > FAIL_WINDOW_MS) {
      this.#attempts.delete(key);
      return true;
    }
    return attempt.fails < MAX_FAILS;
  }

  #fail(key: string): void {
    const now = Date.now();
    const attempt = this.#attempts.get(key);
    if (!attempt || now - attempt.firstAt > FAIL_WINDOW_MS) {
      this.#attempts.set(key, { fails: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    attempt.fails += 1;
    if (attempt.fails >= MAX_FAILS) attempt.lockedUntil = now + FAIL_LOCK_MS;
  }

  #clearFails(key: string): void {
    this.#attempts.delete(key);
  }

  #verifyPin(share: VaultShare, pin: string): boolean {
    if (share.auth !== 'pin' || !share.pinHash || !share.pinSalt) return false;
    try {
      const salt = Buffer.from(share.pinSalt, 'hex');
      const iterations = Math.max(10_000, Math.min(2_000_000, share.pinIterations));
      const hash = pbkdf2Sync(pin, salt, iterations, 32, 'sha256').toString('hex');
      return timingSafeEqualHex(hash, share.pinHash);
    } catch {
      return false;
    }
  }

  #record(
    snapshot: ShareSnapshot,
    action: ShareAccessAction,
    req: IncomingMessage,
    device: ShareDevice | null,
    item?: SharedLogin,
  ): void {
    const access = makeAccess(snapshot.share, action, req, device, item);
    snapshot.share.access = [access, ...snapshot.share.access].slice(0, MAX_ACCESS);
    if (device) device.lastSeenAt = access.at;
    try {
      this.#onEvent({
        shareId: snapshot.share.id,
        access,
        device: device ? { ...device } : null,
        uses: snapshot.share.uses,
      });
    } catch {
      // A renderer that closed while a request was in flight must not turn a
      // valid response into a 500.
    }
  }

  #endedReason(share: VaultShare): string {
    if (share.revokedAt !== null) return 'This share was revoked by its owner.';
    if (share.expiresAt !== null && share.expiresAt <= Date.now()) return 'This share has expired.';
    return '';
  }

  #cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
    for (const [id, preauth] of this.#preauth) {
      if (preauth.expiresAt <= now) this.#preauth.delete(id);
    }
    for (const [key, attempt] of this.#attempts) {
      if (attempt.lockedUntil && attempt.lockedUntil <= now) this.#attempts.delete(key);
      else if (!attempt.lockedUntil && now - attempt.firstAt > FAIL_WINDOW_MS) this.#attempts.delete(key);
    }
    while (this.#sessions.size > MAX_SESSIONS) {
      const first = this.#sessions.keys().next().value;
      if (typeof first !== 'string') break;
      this.#sessions.delete(first);
    }
    while (this.#preauth.size > MAX_PREAUTH) {
      const first = this.#preauth.keys().next().value;
      if (typeof first !== 'string') break;
      this.#preauth.delete(first);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.method) {
      sendHtml(res, 404, errorPage(404, 'Not found', 'Unknown path.'));
      return;
    }
    this.#cleanup();
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const parts = path.split('/').filter(Boolean);

    if (parts[0] !== 's' || !parts[1]) {
      sendHtml(res, 404, errorPage(404, 'Not found', 'Unknown path.'));
      return;
    }

    // Browser-hosted Colax redeems and syncs cross-origin. Preflight asks for
    // these headers before the real request; do not leak whether the code
    // exists at this stage.
    if (
      req.method === 'OPTIONS' &&
      parts.length === 3 &&
      (parts[2] === 'redeem' || parts[2] === 'sync')
    ) {
      securityHeaders(res);
      appCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const appRoute = parts.length === 3 && (parts[2] === 'redeem' || parts[2] === 'sync');
    if (!appRoute) {
      // Every browser route is a dead end. It confirms nothing about whether
      // the code exists, shows no share name, and never renders a login. The
      // app API below is the only path that returns shared fields.
      sendHtml(
        res,
        200,
        page(
          'Private share',
          '<h1>Private share</h1><div class="panel"><p>Open this share in the Colax app. Browser links do not display shared logins.</p></div>',
        ),
      );
      return;
    }
    if (parts[2] === 'redeem' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Use POST for this endpoint.' });
      return;
    }
    if (parts[2] === 'sync' && req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Use GET for this endpoint.' });
      return;
    }

    const code = parts[1];
    if (code.length > 40) {
      sendJson(res, 404, { ok: false, ended: true, error: 'That share code is not valid.' });
      return;
    }
    const snapshot = this.#findByCode(code);
    const rateKey = `${requestIp(req)}|${normaliseShareCode(code)}`;

    if (!snapshot) {
      this.#fail(rateKey);
      if (!this.#allow(rateKey)) {
        if (appRoute) {
          sendJson(res, 429, { ok: false, error: 'Too many attempts. Try again in fifteen minutes.' });
        } else {
          sendHtml(res, 429, errorPage(429, 'Too many attempts', 'Try again in fifteen minutes.'));
        }
        return;
      }
      // A deleted share is an ending, not a transport failure: the app can mark
      // its linked copies ended instead of retrying forever.
      if (appRoute) {
        sendJson(res, 404, {
          ok: false,
          ended: true,
          error: 'This share no longer exists on the owner’s device.',
        });
      } else {
        sendHtml(res, 404, errorPage(404, 'Share not found', 'This code does not match a share on this device.'));
      }
      return;
    }
    const share = snapshot.share;
    const ended = this.#endedReason(share);
    const limitReason =
      share.maxUses !== null && share.uses >= share.maxUses
        ? 'This share has reached its device limit.'
        : '';
    // Approval shares are app-only. A browser has no device identity to
    // approve, so serving it would bypass the owner's allowlist and leak the
    // shared logins to anyone holding the link.
    const browserEnded = ended || limitReason || (share.approval ? 'This share requires an approved device in Colax.' : '');

    /* ---- App API: redeem a code ---------------------------------------- */
    if (parts.length === 3 && parts[2] === 'redeem' && req.method === 'POST') {
      if (ended) {
        sendJson(res, 410, { ok: false, ended: true, error: ended });
        return;
      }
      if (!this.#allow(rateKey)) {
        sendJson(res, 429, { ok: false, error: 'Too many attempts. Try again in fifteen minutes.' });
        return;
      }
      let body: { pin?: unknown; deviceId?: unknown; deviceName?: unknown };
      try {
        const raw = await readBody(req);
        body = raw.json ? (JSON.parse(raw.text) as typeof body) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: 'Malformed request.' });
        return;
      }
      const pin = clean(body.pin, 12).replace(/\D/g, '');
      if (share.auth === 'pin' && !this.#verifyPin(share, pin)) {
        this.#fail(rateKey);
        sendJson(res, 403, { ok: false, error: 'PIN incorrect.' });
        return;
      }
      this.#clearFails(rateKey);

      const now = Date.now();
      const deviceId = clean(body.deviceId, 80) || `dev_${randomId(12)}`;
      const deviceName = clean(body.deviceName, 120) || 'Colax device';
      const rawToken = randomId(32);
      const existing = snapshot.share.devices.find((entry) => entry.id === deviceId);
      if (existing && existing.revokedAt !== null) {
        sendJson(res, 403, {
          ok: false,
          error: 'This device was removed by the owner. Ask for a new share code.',
        });
        return;
      }

      if (share.approval) {
        const alreadyApproved = Boolean(existing && existing.approvedAt !== null);
        if (!alreadyApproved && limitReason) {
          sendJson(res, 410, { ok: false, ended: true, error: limitReason });
          return;
        }
        // A pending device polls by re-redeeming. Keep its original token hash
        // so the owner's approval does not arrive with a hash the recipient
        // discarded; the first redeem after approval rotates and returns one.
        const waiting = Boolean(existing && existing.approvedAt === null);
        const device: ShareDevice = {
          id: deviceId,
          name: deviceName,
          tokenHash: waiting ? existing!.tokenHash : tokenHash(rawToken),
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
          approvedAt: alreadyApproved ? existing?.approvedAt ?? now : null,
          lastIp: requestIp(req),
          userAgent: clean(req.headers['user-agent'], 300),
          revokedAt: null,
        };
        snapshot.share.devices = [
          ...snapshot.share.devices.filter((entry) => entry.id !== deviceId),
          device,
        ].slice(-MAX_DEVICES);
        // The owner sees one pending request, not a new activity row every
        // time the recipient polls while waiting.
        if (!existing || alreadyApproved) this.#record(snapshot, 'redeem', req, device);
        if (!alreadyApproved) {
          sendJson(res, 202, {
            ok: true,
            pending: true,
            shareId: share.id,
            shareName: share.name,
            revision: share.revision,
            fields: share.fields,
            items: [],
            deviceToken: waiting ? '' : rawToken,
            deviceId,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          pending: false,
          shareId: share.id,
          shareName: share.name,
          revision: share.revision,
          fields: share.fields,
          items: snapshot.items,
          deviceToken: rawToken,
          deviceId,
        });
        return;
      }

      if (limitReason) {
        sendJson(res, 410, { ok: false, ended: true, error: limitReason });
        return;
      }
      const device: ShareDevice = {
        id: deviceId,
        name: deviceName,
        tokenHash: tokenHash(rawToken),
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        approvedAt: existing?.approvedAt ?? now,
        lastIp: requestIp(req),
        userAgent: clean(req.headers['user-agent'], 300),
        revokedAt: null,
      };
      // Re-pairing the same device replaces its token rather than stacking a
      // second row with the same name.
      snapshot.share.devices = [
        ...snapshot.share.devices.filter((entry) => entry.id !== deviceId),
        device,
      ].slice(-MAX_DEVICES);
      snapshot.share.uses += 1;
      this.#record(snapshot, 'redeem', req, device);
      sendJson(res, 200, {
        ok: true,
        pending: false,
        shareId: share.id,
        shareName: share.name,
        revision: share.revision,
        fields: share.fields,
        items: snapshot.items,
        deviceToken: rawToken,
        deviceId,
      });
      return;
    }

    /* ---- App API: sync an already-redeemed share ----------------------- */
    if (parts.length === 3 && parts[2] === 'sync' && req.method === 'GET') {
      const auth = clean(req.headers.authorization, 400);
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      const found = this.#findByToken(code, token);
      if (!found) {
        // The code exists but this device's token does not (or was revoked by
        // "New code"). Tell the app to stop retrying rather than turning every
        // launch into a failed network call.
        sendJson(res, 401, {
          ok: false,
          ended: true,
          error: 'This device is no longer paired with the share. Ask the owner for a new code.',
        });
        return;
      }
      if (ended) {
        this.#record(found.snapshot, 'sync', req, found.device);
        sendJson(res, 410, { ok: false, ended: true, error: ended });
        return;
      }
      if (found.device.approvedAt === null) {
        sendJson(res, 202, {
          ok: false,
          pending: true,
          error: 'Waiting for the owner to approve this device.',
        });
        return;
      }
      // Approved devices keep receiving owner edits even after the device
      // limit is full; the limit only stops new enrolments and browser views.
      this.#record(found.snapshot, 'sync', req, found.device);
      sendJson(res, 200, {
        ok: true,
        shareId: found.snapshot.share.id,
        shareName: found.snapshot.share.name,
        revision: found.snapshot.share.revision,
        fields: found.snapshot.share.fields,
        items: found.snapshot.items,
        ended: false,
      });
      return;
    }

    /* ---- Browser: PIN gate --------------------------------------------- */
    const session = this.#sessionFor(req, share.id);
    if (share.auth === 'pin' && !session) {
      if (browserEnded) {
        sendHtml(res, 410, errorPage(410, 'Share ended', browserEnded));
        return;
      }
      if (req.method === 'POST' && parts.length === 2) {
        if (!this.#allow(rateKey)) {
          sendHtml(res, 429, errorPage(429, 'Too many attempts', 'Try again in fifteen minutes.'));
          return;
        }
        let text = '';
        try {
          text = (await readBody(req)).text;
        } catch {
          sendHtml(res, 413, errorPage(413, 'Too large', 'That request was too large.'));
          return;
        }
        const form = new URLSearchParams(text);
        const gate = readCookies(req).colax_gate;
        const preauth = gate ? this.#preauth.get(gate) : undefined;
        const csrf = clean(form.get('csrf'), 200);
        const pin = clean(form.get('pin'), 12).replace(/\D/g, '');
        if (!preauth || preauth.shareId !== share.id || preauth.expiresAt <= Date.now() || preauth.csrf !== csrf) {
          sendHtml(res, 403, errorPage(403, 'Form expired', 'Reload the share page and try again.'));
          return;
        }
        if (!this.#verifyPin(share, pin)) {
          this.#fail(rateKey);
          const nextCsrf = this.#makePreauth(res, req, share.id, `/s/${code}`);
          sendHtml(res, 403, pinPage(code, nextCsrf, share.name, 'That PIN is not correct.'));
          return;
        }
        this.#clearFails(rateKey);
        if (gate) this.#preauth.delete(gate);
        this.#makeSession(res, req, share.id, `/s/${code}`);
        this.#record(snapshot, 'view', req, null);
        res.statusCode = 303;
        res.setHeader('Location', `/s/${code}`);
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        sendHtml(res, 405, errorPage(405, 'Method not allowed', 'Use the form on the share page.'));
        return;
      }
      const csrf = this.#makePreauth(res, req, share.id, `/s/${code}`);
      sendHtml(res, 200, pinPage(code, csrf, share.name));
      return;
    }

    if (req.method !== 'GET') {
      sendHtml(res, 405, errorPage(405, 'Method not allowed', 'This share is read-only.'));
      return;
    }
    if (browserEnded) {
      sendHtml(res, 410, errorPage(410, 'Share ended', browserEnded));
      return;
    }

    /* ---- Browser: item pages ------------------------------------------- */
    if (parts.length === 4 && parts[2] === 'logins') {
      const itemId = decodeURIComponent(parts[3] ?? '');
      if (!share.itemIds.includes(itemId)) {
        sendHtml(res, 404, errorPage(404, 'Login not found', 'That login is not part of this share.'));
        return;
      }
      const item = snapshot.items.find((entry) => entry.id === itemId);
      if (!item) {
        sendHtml(res, 404, errorPage(404, 'Login not found', 'The owner has removed that login from this share.'));
        return;
      }
      this.#record(snapshot, 'open-login', req, null, item);
      sendHtml(res, 200, loginPage(code, share, item));
      return;
    }

    if (parts.length === 2 || (parts.length === 3 && parts[2] === 'logins')) {
      this.#record(snapshot, 'view', req, null);
      sendHtml(res, 200, loginListPage(code, share, snapshot.items));
      return;
    }

    sendHtml(res, 404, errorPage(404, 'Not found', 'Unknown path.'));
  }
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

function lanAddress(): string {
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
  } catch {
    // Fall through to loopback: a host with no LAN interface still has a server.
  }
  return '127.0.0.1';
}


