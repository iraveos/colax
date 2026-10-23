/**
 * The client side of a share, shared by Electron main and the web build.
 *
 * Keeping it here is what lets a browser tab redeem a share too: the only
 * difference between the two shells is which `fetch` call reaches the owner's
 * server. The owner's app endpoints opt in to CORS; the browser page does not.
 */

import {
  formatShareCode,
  isShareCode,
  normaliseBaseUrl,
  normaliseShareCode,
  normaliseShareFields,
  parseShareEntry,
  type ShareRedeemInput,
  type ShareRedeemResult,
  type ShareSyncResult,
  type ShareSyncShareResult,
  type ShareSyncTarget,
} from './shares.ts';

function emptyRedeem(error: string): ShareRedeemResult {
  return {
    ok: false,
    error,
    shareId: '',
    shareName: '',
    ownerUrl: '',
    code: '',
    deviceToken: '',
    revision: 0,
    fields: { notes: true, totp: false, attachments: false },
    items: [],
  };
}

function shareBase(entry: string, host: string): { code: string; baseUrl: string } {
  const parsed = parseShareEntry(entry, host);
  const code = normaliseShareCode(parsed.code);
  return { code: isShareCode(code) ? code : '', baseUrl: normaliseBaseUrl(parsed.baseUrl) };
}

async function fetchShareJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON is reported by the caller through the status.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function redeemShare(input: ShareRedeemInput): Promise<ShareRedeemResult> {
  const { code, baseUrl } = shareBase(input.entry, input.host);
  if (!code) return emptyRedeem('That does not look like a share code.');
  if (!baseUrl) {
    return emptyRedeem('Enter the owner’s address too, for example 192.168.1.5:47821.');
  }
  const url = `${baseUrl}/s/${encodeURIComponent(formatShareCode(code))}/redeem`;
  try {
    const { status, body } = await fetchShareJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pin: input.pin,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
      }),
    });
    if (status === 200 && body.ok === true && Array.isArray(body.items)) {
      return {
        ok: true,
        error: '',
        shareId: typeof body.shareId === 'string' ? body.shareId : '',
        shareName: typeof body.shareName === 'string' ? body.shareName : 'Shared logins',
        ownerUrl: baseUrl,
        code,
        deviceToken: typeof body.deviceToken === 'string' ? body.deviceToken : '',
        revision: typeof body.revision === 'number' ? body.revision : 1,
        fields: normaliseShareFields(body.fields),
        items: body.items as ShareRedeemResult['items'],
      };
    }
    return emptyRedeem(
      typeof body.error === 'string'
        ? body.error
        : status === 429
          ? 'Too many attempts. Wait fifteen minutes and try again.'
          : 'The owner’s device did not accept that share.',
    );
  } catch {
    return emptyRedeem(
      'Could not reach the owner’s device. Check the address, that Colax is open there, and that both devices are online.',
    );
  }
}

export async function syncLinkedShares(input: unknown): Promise<ShareSyncResult> {
  if (!Array.isArray(input)) return { results: [] };
  const targets = input
    .filter(
      (entry): entry is ShareSyncTarget =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as ShareSyncTarget).shareId === 'string' &&
        typeof (entry as ShareSyncTarget).ownerUrl === 'string' &&
        typeof (entry as ShareSyncTarget).code === 'string' &&
        typeof (entry as ShareSyncTarget).deviceToken === 'string',
    )
    .slice(0, 50);
  const results = await Promise.all(
    targets.map(async (target): Promise<ShareSyncShareResult> => {
      const code = normaliseShareCode(target.code);
      const baseUrl = normaliseBaseUrl(target.ownerUrl);
      const empty: ShareSyncShareResult = {
        shareId: target.shareId,
        shareName: '',
        revision: 0,
        fields: { notes: true, totp: false, attachments: false },
        items: [],
        ended: false,
        error: '',
      };
      if (!isShareCode(code) || !baseUrl) {
        return { ...empty, ended: true, error: 'The saved share address is not valid.' };
      }
      const url = `${baseUrl}/s/${encodeURIComponent(formatShareCode(code))}/sync`;
      try {
        const { status, body } = await fetchShareJson(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${target.deviceToken}` },
        });
        if (status === 200 && body.ok === true && Array.isArray(body.items)) {
          return {
            shareId: target.shareId,
            shareName: typeof body.shareName === 'string' ? body.shareName : '',
            revision: typeof body.revision === 'number' ? body.revision : 1,
            fields: normaliseShareFields(body.fields),
            items: body.items as ShareSyncShareResult['items'],
            ended: false,
            error: '',
          };
        }
        if (status === 410 || body.ended === true) {
          return {
            ...empty,
            ended: true,
            error: typeof body.error === 'string' ? body.error : 'This share has ended.',
          };
        }
        return {
          ...empty,
          error:
            typeof body.error === 'string'
              ? body.error
              : status === 401
                ? 'This device is no longer paired with that share.'
                : 'The owner’s device could not be reached.',
        };
      } catch {
        return {
          ...empty,
          error: 'Offline: the owner’s device could not be reached.',
        };
      }
    }),
  );
  return { results };
}
