/**
 * Optional public HTTPS front door for the local share server.
 *
 * A machine behind a home router cannot accept inbound connections without
 * either a port-forward (and a certificate) or a tunnel. This module owns the
 * second option: Cloudflare's `cloudflared` Quick Tunnel, downloaded once into
 * the app's user-data directory and run as a child process. It is opt-in,
 * Windows-first, and deliberately separate from the HTTP server so the server
 * stays testable without Electron or a network.
 *
 * The public URL is ephemeral and belongs to Cloudflare. The tunnel encrypts
 * traffic to Cloudflare's edge, but Cloudflare terminates TLS, so this is not
 * an end-to-end private path. The UI says so before the switch is turned on.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { app } from 'electron';
import type { ShareTunnelState } from '../src/lib/shares.ts';

const DOWNLOAD_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const TUNNEL_START_TIMEOUT_MS = 60 * 1000;

export interface ShareTunnelStatus {
  state: ShareTunnelState;
  url: string;
  error: string;
}

/** Pulls the first Quick Tunnel hostname out of cloudflared's log stream. */
export function parseTunnelUrl(output: string): string {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(output)?.[0]?.toLowerCase() ?? '';
}

function stopped(): ShareTunnelStatus {
  return { state: 'off', url: '', error: '' };
}

/**
 * Cloudflare's edge DNS can lag behind the tunnel process by several seconds.
 * A request through the public hostname is the only reliable readiness check.
 */
async function waitForPublicUrl(url: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      try {
        await response.arrayBuffer();
      } catch {}
      if (response.status < 500) return true;
    } catch {
      // DNS, TLS or edge routing not ready yet; retry.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * One tunnel per process. Main owns the instance; it never touches the vault.
 */
export class ShareTunnel {
  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #status: ShareTunnelStatus = stopped();
  #target = '';
  #generation = 0;
  #starting: Promise<ShareTunnelStatus> | null = null;
  #startingTarget = '';
  #onStatus: (status: ShareTunnelStatus) => void;

  constructor(onStatus: (status: ShareTunnelStatus) => void = () => {}) {
    this.#onStatus = onStatus;
  }

  status(): ShareTunnelStatus {
    return { ...this.#status };
  }

  async start(targetUrl: string): Promise<ShareTunnelStatus> {
    if (
      targetUrl &&
      this.#status.state === 'running' &&
      this.#target === targetUrl &&
      this.#child
    ) {
      return this.status();
    }
    if (this.#starting && this.#startingTarget === targetUrl) return this.#starting;

    await this.stop();
    this.#target = targetUrl;
    const generation = ++this.#generation;
    this.#startingTarget = targetUrl;
    this.#set({ state: 'starting', url: '', error: '' });
    const task = this.#launch(targetUrl, generation);
    this.#starting = task;
    try {
      return await task;
    } finally {
      if (this.#starting === task) {
        this.#starting = null;
        this.#startingTarget = '';
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#target = '';
    // A launch that is still downloading or waiting for Cloudflare must not be
    // reused by a later start: it is about to be cancelled by this stop.
    this.#generation += 1;
    this.#starting = null;
    this.#startingTarget = '';
    this.#set(stopped());
    if (!child) return;
    try {
      child.kill();
    } catch {}
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      }
    } catch {
      // The process is already gone; the status is still off.
    }
  }

  async #launch(targetUrl: string, generation: number): Promise<ShareTunnelStatus> {
    let binary = '';
    try {
      binary = await ensureCloudflared();
    } catch (cause) {
      if (this.#generation !== generation) return this.status();
      this.#set({
        state: 'error',
        url: '',
        error: cause instanceof Error ? cause.message : 'Could not download the tunnel helper.',
      });
      return this.status();
    }
    // The download can take minutes. A stop (lock, reload or toggle) during
    // that time must not spawn a helper afterwards.
    if (this.#generation !== generation) return this.status();

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        binary,
        [
          'tunnel',
          '--url',
          targetUrl,
          '--no-autoupdate',
          '--protocol',
          'http2',
          '--edge-ip-version',
          '4',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (cause) {
      if (this.#generation !== generation) return this.status();
      this.#set({
        state: 'error',
        url: '',
        error: cause instanceof Error ? cause.message : 'Could not start the tunnel helper.',
      });
      return this.status();
    }
    this.#child = child;

    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (next: ShareTunnelStatus) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // A stop can land while the helper is still starting. In that case the
      // stale launch must not overwrite the off state with an error.
      if (
        this.#generation !== generation ||
        this.#child !== child ||
        this.#target !== targetUrl
      ) {
        return;
      }
      this.#set(next);
    };

    const url = await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        output = (output + String(chunk)).slice(-32_000);
        const found = parseTunnelUrl(output);
        // Printing the hostname is not the same as the edge accepting it.
        // Waiting for a registered connection avoids handing out a link that
        // still returns NXDOMAIN for the first few seconds.
        if (found && /Registered tunnel connection|Connection\s+\S+\s+registered/i.test(output)) {
          resolve(found);
        }
      };

      timer = setTimeout(() => {
        reject(new Error('Cloudflare did not provide a reachable public address in time.'));
      }, TUNNEL_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (cause) => reject(cause));
      child.once('exit', (code) => {
        if (!settled) {
          const tail = output.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          reject(
            new Error(
              tail
                ? `Cloudflare tunnel exited (${code ?? 'unknown'}). ${tail}`
                : `Cloudflare tunnel exited (${code ?? 'unknown'}).`,
            ),
          );
        }
      });
    }).catch((cause: unknown): string => {
      finish({
        state: 'error',
        url: '',
        error: cause instanceof Error ? cause.message : 'Could not start the tunnel.',
      });
      return '';
    });

    if (!url) {
      if (this.#child === child) {
        this.#child = null;
        try {
          child.kill();
        } catch {}
      }
      return this.status();
    }

    // Keep watching after the URL appears: a tunnel that dies later should not
    // leave the UI promising an address that no longer resolves.
    child.once('exit', (code) => {
      if (this.#child !== child || this.#generation !== generation) return;
      this.#child = null;
      this.#target = '';
      this.#set({
        state: 'error',
        url: '',
        error: `Cloudflare tunnel closed (${code ?? 'unknown'}).`,
      });
    });
    child.once('error', (cause) => {
      if (this.#child !== child || this.#generation !== generation) return;
      this.#child = null;
      this.#target = '';
      this.#set({
        state: 'error',
        url: '',
        error: cause instanceof Error ? cause.message : 'Cloudflare tunnel failed.',
      });
    });

    // Cloudflare hands out the hostname before its DNS and edge routes are
    // ready. A link copied at that moment can look broken for ten seconds or
    // more, so the tunnel is not "running" until a request actually reaches
    // this server through the public address.
    const reachable = await waitForPublicUrl(url);
    if (!reachable || this.#child !== child || this.#generation !== generation) {
      finish({
        state: 'error',
        url: '',
        error: 'Cloudflare created an address, but it did not become reachable. Try again shortly.',
      });
      if (this.#child === child) {
        this.#child = null;
        try {
          child.kill();
        } catch {}
      }
      return this.status();
    }

    finish({ state: 'running', url, error: '' });
    return this.status();
  }

  #set(next: ShareTunnelStatus): void {
    this.#status = next;
    try {
      this.#onStatus({ ...next });
    } catch {
      // The renderer may be gone while a tunnel is shutting down.
    }
  }
}

let cloudflaredDownload: Promise<string> | null = null;

function ensureCloudflared(): Promise<string> {
  // Coalesce concurrent starts. A lock/toggle during the first download should
  // not make the next attempt write the same 55 MB file at the same time.
  if (!cloudflaredDownload) {
    cloudflaredDownload = downloadCloudflared().finally(() => {
      cloudflaredDownload = null;
    });
  }
  return cloudflaredDownload;
}

async function downloadCloudflared(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Automatic internet sharing currently downloads cloudflared for Windows. On this platform, install cloudflared and use a manual public address.',
    );
  }
  const directory = join(app.getPath('userData'), 'share-tunnel');
  const file = join(directory, 'cloudflared.exe');
  try {
    if (existsSync(file) && statSync(file).size > 1_000_000) return file;
  } catch {
    // Fall through and download a fresh copy.
  }
  mkdirSync(directory, { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(DOWNLOAD_URL, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Colax share tunnel' },
    });
    if (!response.ok) {
      throw new Error(`Could not download cloudflared (HTTP ${response.status}).`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1_000_000 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw new Error('The tunnel helper download was not a valid Windows executable.');
    }
    writeFileSync(file, buffer, { mode: 0o755 });
    return file;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new Error('Downloading the tunnel helper timed out. Check the internet connection.');
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
