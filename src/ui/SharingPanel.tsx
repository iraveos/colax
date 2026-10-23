/**
 * Settings › Sharing.
 *
 * The owner-facing half of sharing: the local server, share rules, one-time
 * codes, paired devices and what those devices did. The recipient-facing half
 * is the redeem box at the bottom and the automatic sync running in App.
 */

import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { getPlatform } from '../lib/platform.ts';
import {
  formatShareCode,
  normaliseBaseUrl,
  shareLinkFor,
  shareStatus,
  type ShareFields,
  type ShareRedeemResult,
  type ShareServerConfig,
  type ShareServerStatus,
  type VaultShare,
} from '../lib/shares.ts';
import {
  createShareRecord,
  hashPin,
  hashShareCode,
  makeShareCode,
  nextShareRevision,
  normalisePin,
} from '../vault/shares.ts';
import type { VaultItem } from '../vault/types.ts';
import type { VaultPreferences } from '../vault/storage.ts';
import type { Toast } from './hooks.ts';
import { Alert, Modal, Select, Toggle } from './primitives.tsx';
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  EditIcon,
  ExternalIcon,
  LockIcon,
  PlusIcon,
  ShareIcon,
  TrashIcon,
  XIcon,
} from './icons.tsx';

interface ShareFormValues {
  name: string;
  itemIds: string[];
  expiresAt: number | null;
  maxUses: number | null;
  pinMode: 'code' | 'pin';
  pin: string;
  fields: ShareFields;
}

export function SharingPanel({
  prefs,
  items,
  serverStatus,
  onUpdate,
  onNotify,
  onRedeemShare,
  onSyncShared,
  shareSyncing,
}: {
  prefs: VaultPreferences;
  items: VaultItem[];
  serverStatus: ShareServerStatus;
  onUpdate: (patch: Partial<VaultPreferences>) => Promise<void>;
  onNotify: (message: string, tone?: Toast['tone']) => void;
  onRedeemShare?: (input: { entry: string; host: string; pin: string }) => Promise<ShareRedeemResult>;
  onSyncShared?: () => Promise<number>;
  shareSyncing?: boolean;
}) {
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; share: VaultShare } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealShareId, setRevealShareId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    { kind: 'revoke' | 'delete' | 'new-code'; shareId: string } | null
  >(null);
  const [openDetails, setOpenDetails] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState(String(prefs.shareServer.port));
  const [publicDraft, setPublicDraft] = useState(prefs.shareServer.publicUrl);
  const [qr, setQr] = useState('');
  const [entry, setEntry] = useState('');
  const [host, setHost] = useState('');
  const [pin, setPin] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');
  const [redeemDone, setRedeemDone] = useState('');

  useEffect(() => {
    setPortDraft(String(prefs.shareServer.port));
  }, [prefs.shareServer.port]);
  useEffect(() => {
    setPublicDraft(prefs.shareServer.publicUrl);
  }, [prefs.shareServer.publicUrl]);

  const server = prefs.shareServer;
  const publicBase =
    normaliseBaseUrl(serverStatus.publicUrl) || normaliseBaseUrl(server.publicUrl);
  const localBase = normaliseBaseUrl(serverStatus.localUrl);
  // A public tunnel in the starting/error state must not hand out a
  // localhost link: the recipient could never open it. A manual public URL
  // remains a valid fallback while the helper is starting.
  const baseUrl = publicBase || (server.tunnel === 'cloudflare' ? '' : localBase);
  const revealedShare = revealShareId
    ? prefs.shares.find((share) => share.id === revealShareId) ?? null
    : null;
  const revealedCode = revealShareId ? revealed[revealShareId] ?? '' : '';
  const revealLink = revealedShare && revealedCode && baseUrl ? shareLinkFor(baseUrl, revealedCode) : '';

  useEffect(() => {
    if (!revealLink) {
      setQr('');
      return;
    }
    let live = true;
    void QRCode.toDataURL(revealLink, { margin: 1, width: 220 })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr('');
      });
    return () => {
      live = false;
    };
  }, [revealLink]);

  const linked = useMemo(() => items.filter((item) => item.shareLink !== null), [items]);
  const activeShares = prefs.shares.filter((share) => shareStatus(share) === 'active');
  const desktop = typeof window !== 'undefined' && window.platform?.share !== undefined;

  function saveServer(patch: Partial<ShareServerConfig>): void {
    void onUpdate({ shareServer: { ...server, ...patch } });
  }

  async function copy(value: string, label: string): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      onNotify(`${label} copied`);
    } catch {
      onNotify('Could not reach the clipboard', 'error');
    }
  }

  async function submitCreate(values: ShareFormValues): Promise<string | null> {
    if (values.itemIds.length === 0) return 'Pick at least one login to share.';
    if (values.pinMode === 'pin' && !/^\d{4,12}$/.test(normalisePin(values.pin))) {
      return 'A PIN needs 4 to 12 digits.';
    }
    const generated = makeShareCode();
    const share = await createShareRecord({
      name: values.name,
      code: generated.code,
      pin: values.pinMode === 'pin' ? values.pin : '',
      itemIds: values.itemIds,
      fields: values.fields,
      expiresAt: values.expiresAt,
      maxUses: values.maxUses,
    });
    await onUpdate({ shares: [share, ...prefs.shares] });
    setRevealed((current) => ({ ...current, [share.id]: generated.code }));
    setRevealShareId(share.id);
    setForm(null);
    onNotify(
      server.enabled
        ? 'Share created. Copy the code now; it is not stored.'
        : 'Share created. Turn on the sharing server below so devices can connect.',
    );
    return null;
  }

  async function submitEdit(share: VaultShare, values: ShareFormValues): Promise<string | null> {
    if (values.itemIds.length === 0) return 'Pick at least one login to share.';
    const typedPin = normalisePin(values.pin);
    if (values.pinMode === 'pin' && !typedPin && share.auth !== 'pin') {
      return 'A PIN needs 4 to 12 digits.';
    }
    if (typedPin && !/^\d{4,12}$/.test(typedPin)) return 'A PIN needs 4 to 12 digits.';

    let pinHash = share.pinHash;
    let pinSalt = share.pinSalt;
    let pinIterations = share.pinIterations;
    if (values.pinMode === 'pin') {
      if (typedPin) {
        const hashed = await hashPin(typedPin);
        pinHash = hashed.hash;
        pinSalt = hashed.salt;
        pinIterations = hashed.iterations;
      }
    } else {
      pinHash = '';
      pinSalt = '';
      pinIterations = 0;
    }

    const next: VaultShare = {
      ...share,
      name: values.name.trim() || share.name,
      expiresAt: values.expiresAt,
      maxUses: values.maxUses,
      auth: pinHash ? 'pin' : 'code',
      pinHash,
      pinSalt,
      pinIterations,
      itemIds: values.itemIds,
      fields: values.fields,
      revision: share.revision + 1,
      updatedAt: Date.now(),
    };
    await onUpdate({
      shares: prefs.shares.map((entryShare) => (entryShare.id === share.id ? next : entryShare)),
    });
    setForm(null);
    onNotify('Share updated');
    return null;
  }

  async function revokeShare(share: VaultShare): Promise<void> {
    const next = nextShareRevision({ ...share, revokedAt: Date.now() });
    await onUpdate({
      shares: prefs.shares.map((entryShare) => (entryShare.id === share.id ? next : entryShare)),
    });
    setConfirmAction(null);
    onNotify('Share revoked. New syncs stop immediately.');
  }

  async function deleteShare(share: VaultShare): Promise<void> {
    await onUpdate({ shares: prefs.shares.filter((entryShare) => entryShare.id !== share.id) });
    setConfirmAction(null);
    setRevealShareId(null);
    onNotify('Share deleted');
  }

  async function newCode(share: VaultShare): Promise<void> {
    const generated = makeShareCode();
    const codeHash = await hashShareCode(generated.code);
    const next = nextShareRevision({
      ...share,
      codeHash,
      devices: [],
      uses: 0,
      revokedAt: null,
    });
    await onUpdate({
      shares: prefs.shares.map((entryShare) => (entryShare.id === share.id ? next : entryShare)),
    });
    setRevealed((current) => ({ ...current, [share.id]: generated.code }));
    setRevealShareId(share.id);
    setConfirmAction(null);
    onNotify('New code generated. Previous devices were disconnected.');
  }

  async function disconnectDevice(share: VaultShare, deviceId: string): Promise<void> {
    const next = nextShareRevision({
      ...share,
      devices: share.devices.map((device) =>
        device.id === deviceId ? { ...device, revokedAt: Date.now() } : device,
      ),
    });
    await onUpdate({
      shares: prefs.shares.map((entryShare) => (entryShare.id === share.id ? next : entryShare)),
    });
    onNotify('Device disconnected');
  }

  async function redeem(): Promise<void> {
    setRedeemError('');
    setRedeemDone('');
    if (!onRedeemShare) {
      setRedeemError('Sharing needs the Colax desktop app.');
      return;
    }
    if (!entry.trim()) {
      setRedeemError('Paste a share link or enter a code.');
      return;
    }
    setRedeeming(true);
    try {
      const result = await onRedeemShare({ entry: entry.trim(), host: host.trim(), pin: normalisePin(pin) });
      if (!result.ok) {
        setRedeemError(result.error || 'That share could not be opened.');
        return;
      }
      setEntry('');
      setHost('');
      setPin('');
      setRedeemDone(
        result.items.length === 1
          ? '1 login imported as a linked copy.'
          : `${result.items.length} logins imported as linked copies.`,
      );
    } catch (cause) {
      setRedeemError(cause instanceof Error ? cause.message : 'That share could not be opened.');
    } finally {
      setRedeeming(false);
    }
  }

  const confirmShare = confirmAction
    ? prefs.shares.find((share) => share.id === confirmAction.shareId) ?? null
    : null;

  return (
    <div className="sharing">
      <Alert tone="info">
        Sharing is direct: the other device talks to this one. Colax does not run a central relay, and the
        share server only works while this vault is unlocked. Turn on <strong>Internet access</strong> below
        for a public HTTPS link that opens in any browser; leave it off for this device or your local
        network.
      </Alert>

      <div className="sec__card">
        <div className="sharing__head">
          <div>
            <h3 className="sec__title">Sharing server</h3>
            <p className="sharing__meta">
              {server.enabled
                ? serverStatus.running
                  ? `Listening on ${serverStatus.localUrl}`
                  : serverStatus.error || 'Starting…'
                : 'Off. Codes will not connect until this is on.'}
            </p>
          </div>
          <span
            className={`sharing__status ${serverStatus.running ? 'sharing__status--on' : ''}`}
            aria-label={serverStatus.running ? 'Server running' : 'Server stopped'}
          />
          <Toggle
            label="Share server"
            checked={server.enabled}
            onChange={(enabled) => saveServer({ enabled })}
          />
        </div>

        {!desktop ? (
          <Alert tone="warn">The share server needs the Colax desktop app. Web builds can still edit shares, but cannot listen for connections.</Alert>
        ) : null}
        {serverStatus.error ? <p className="sec__error">{serverStatus.error}</p> : null}

        <div className="sharing__grid">
          <div className="field">
            <label className="field__label" htmlFor="share-port">Port</label>
            <input
              id="share-port"
              className="input input--port"
              inputMode="numeric"
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={() => {
                const next = Number(portDraft);
                if (Number.isFinite(next) && next >= 1024 && next <= 65535) saveServer({ port: next });
                else setPortDraft(String(server.port));
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">Who can connect</label>
            <Select
              label="Who can connect"
              value={server.bind}
              options={[
                { value: 'local', label: 'This device only', hint: '127.0.0.1' },
                { value: 'lan', label: 'Local network', hint: 'Phones and other computers on your Wi-Fi' },
              ]}
              onChange={(bind) => saveServer({ bind: bind === 'lan' ? 'lan' : 'local' })}
            />
          </div>
          <div className="field">
            <label className="field__label">Internet access</label>
            <Select
              label="Internet access"
              value={server.tunnel}
              options={[
                { value: 'off', label: 'Off', hint: 'This device or the local network only' },
                {
                  value: 'cloudflare',
                  label: 'Cloudflare Quick Tunnel',
                  hint: 'Public HTTPS link that works in any browser',
                },
              ]}
              onChange={(tunnel) =>
                saveServer({ tunnel: tunnel === 'cloudflare' ? 'cloudflare' : 'off' })
              }
            />
            <span className="field__hint">
              Automatic public access for a phone on mobile data or a recipient anywhere on the internet.
            </span>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="share-public-url">Manual public address (optional)</label>
            <input
              id="share-public-url"
              className="input"
              placeholder="https://share.example.com"
              value={publicDraft}
              onChange={(event) => setPublicDraft(event.target.value)}
              onBlur={() => {
                const next = normaliseBaseUrl(publicDraft);
                if (next !== server.publicUrl) saveServer({ publicUrl: next });
                else setPublicDraft(next);
              }}
            />
            <span className="field__hint">
              A stable named tunnel or reverse proxy. A live Quick Tunnel address takes priority in copied
              links.
            </span>
          </div>
        </div>

        {server.enabled && server.tunnel === 'cloudflare' ? (
          <div className="sharing__tunnel">
            <div className="sharing__tunnel-head">
              <span className={`sharing__status ${serverStatus.tunnel === 'running' ? 'sharing__status--on' : ''}`} />
              <strong>
                {serverStatus.tunnel === 'running'
                  ? 'Public link is live'
                  : serverStatus.tunnel === 'error'
                    ? 'Public link failed'
                    : serverStatus.tunnel === 'starting'
                      ? 'Opening a public link…'
                      : 'Not started'}
              </strong>
              {serverStatus.tunnel === 'running' && serverStatus.publicUrl ? (
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => void copy(serverStatus.publicUrl, 'Public link')}
                >
                  <CopyIcon width="13" height="13" /> Copy public link
                </button>
              ) : null}
            </div>
            {serverStatus.tunnel === 'running' ? (
              <code className="sharing__code-value">{serverStatus.publicUrl}</code>
            ) : null}
            {serverStatus.tunnel === 'error' ? (
              <p className="sec__error">{serverStatus.tunnelError || 'The tunnel could not start.'}</p>
            ) : null}
            {serverStatus.tunnel === 'starting' ? (
              <p className="field__note">
                The first run downloads Cloudflare’s signed tunnel helper (about 60 MB). Keep this window
                open until the address appears.
              </p>
            ) : null}
            <p className="field__note">
              Traffic is HTTPS to Cloudflare’s edge, then through an encrypted tunnel to this device.
              Cloudflare terminates TLS and the address changes when the app restarts. Use a code + PIN
              for shares that leave your network. For a stable or end-to-end private path, use a named
              tunnel or Tailscale under Manual public address.
            </p>
          </div>
        ) : null}

        <div className="sharing__urls">
          {serverStatus.localUrl ? (
            <button className="btn btn--secondary btn--sm" onClick={() => void copy(serverStatus.localUrl, 'Local address')}>
              <CopyIcon width="13" height="13" /> Copy local address
            </button>
          ) : null}
          {baseUrl ? <span className="field__note">Links use {baseUrl}</span> : null}
          <span className="field__note">
            {server.tunnel === 'cloudflare'
              ? 'The public tunnel reaches the loopback server. “Who can connect” only controls direct LAN access.'
              : server.bind === 'lan'
                ? 'Your firewall may ask once. Allow it on private networks only.'
                : 'Only this computer can reach the server. Choose Local network or Internet access to share further.'}
          </span>
        </div>
      </div>

      <div className="sec__card">
        <div className="sharing__head">
          <div>
            <h3 className="sec__title">Share codes</h3>
            <p className="sharing__meta">
              {activeShares.length} active · {prefs.shares.length} total. A code is shown once, then only its
              hash is stored.
            </p>
          </div>
          <button className="btn btn--primary btn--sm" onClick={() => setForm({ mode: 'create' })}>
            <PlusIcon width="14" height="14" /> New share
          </button>
        </div>

        {prefs.shares.length === 0 ? (
          <div className="sharing__empty">
            <ShareIcon width="24" height="24" />
            <p>No shares yet. Pick a few logins, set rules, and send someone the code.</p>
          </div>
        ) : (
          <ul className="sharing__list">
            {prefs.shares.map((share) => {
              const status = shareStatus(share);
              const code = revealed[share.id];
              const open = openDetails === share.id;
              return (
                <li className="sharing__item" key={share.id}>
                  <div className="sharing__item-head">
                    <div className="sharing__item-title">
                      <strong>{share.name}</strong>
                      <span className={`chip ${status === 'active' ? 'chip--accent' : 'chip--muted'}`}>
                        {status}
                      </span>
                      <span className="chip chip--muted">
                        <LockIcon width="10" height="10" />
                        {share.auth === 'pin' ? 'Code + PIN' : 'Code only'}
                      </span>
                    </div>
                    <div className="sharing__item-meta">
                      {share.itemIds.length} login{share.itemIds.length === 1 ? '' : 's'} · {share.uses}
                      {share.maxUses === null ? ' uses' : ` of ${share.maxUses} uses`} ·{' '}
                      {share.expiresAt === null
                        ? 'no expiry'
                        : share.expiresAt <= Date.now()
                          ? 'expired'
                          : `expires ${new Date(share.expiresAt).toLocaleDateString()}`}
                    </div>
                  </div>

                  {code && baseUrl ? (
                    <div className="sharing__code">
                      <div>
                        <span className="sharing__code-label">Code</span>
                        <code className="sharing__code-value">{formatShareCode(code)}</code>
                      </div>
                      <button
                        className="btn btn--quiet btn--sm"
                        onClick={() => void copy(formatShareCode(code), 'Code')}
                      >
                        <CopyIcon width="12" height="12" /> Copy
                      </button>
                      <button
                        className="btn btn--secondary btn--sm"
                        onClick={() => void copy(shareLinkFor(baseUrl, code), 'Link')}
                      >
                        <CopyIcon width="12" height="12" /> Copy link
                      </button>
                    </div>
                  ) : null}

                  <div className="sharing__actions">
                    {code ? (
                      <button className="btn btn--quiet btn--sm" onClick={() => setRevealShareId(share.id)}>
                        <ShareIcon width="12" height="12" /> Show code
                      </button>
                    ) : status === 'active' ? (
                      <button
                        className="btn btn--quiet btn--sm"
                        onClick={() => setConfirmAction({ kind: 'new-code', shareId: share.id })}
                      >
                        New code
                      </button>
                    ) : null}
                    <button
                      className="btn btn--secondary btn--sm"
                      onClick={() => setForm({ mode: 'edit', share })}
                    >
                      <EditIcon width="12" height="12" /> Edit rules
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => setOpenDetails(open ? null : share.id)}
                    >
                      <ClockIcon width="12" height="12" /> {open ? 'Hide' : 'Devices & activity'}
                    </button>
                    {status === 'active' ? (
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => setConfirmAction({ kind: 'revoke', shareId: share.id })}
                      >
                        <XIcon width="12" height="12" /> Revoke
                      </button>
                    ) : null}
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() => setConfirmAction({ kind: 'delete', shareId: share.id })}
                    >
                      <TrashIcon width="12" height="12" /> Delete
                    </button>
                  </div>

                  {open ? (
                    <div className="sharing__details">
                      <div>
                        <h4 className="sharing__subtitle">Connected devices</h4>
                        {share.devices.length === 0 ? (
                          <p className="field__note">No device has redeemed this share yet.</p>
                        ) : (
                          <ul className="sharing__devices">
                            {share.devices.map((device) => (
                              <li key={device.id}>
                                <div>
                                  <strong>{device.name}</strong>
                                  <span>
                                    {device.revokedAt
                                      ? 'Disconnected'
                                      : `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                                    {device.lastIp ? ` · ${device.lastIp}` : ''}
                                  </span>
                                </div>
                                {!device.revokedAt ? (
                                  <button
                                    className="btn btn--ghost btn--sm"
                                    onClick={() => void disconnectDevice(share, device.id)}
                                  >
                                    Disconnect
                                  </button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <h4 className="sharing__subtitle">Recent activity</h4>
                        {share.access.length === 0 ? (
                          <p className="field__note">Nothing yet.</p>
                        ) : (
                          <ul className="sharing__log">
                            {share.access.slice(0, 20).map((entryRow) => (
                              <li key={entryRow.id}>
                                <span className="sharing__log-action">
                                  {entryRow.action === 'redeem'
                                    ? 'Redeemed'
                                    : entryRow.action === 'sync'
                                      ? 'Synced'
                                      : entryRow.action === 'open-login'
                                        ? 'Opened login'
                                        : 'Viewed share'}
                                </span>
                                <span>
                                  {entryRow.deviceName || 'Browser'}
                                  {(() => {
                                    const title =
                                      entryRow.itemTitle ||
                                      items.find((item) => item.id === entryRow.itemId)?.title ||
                                      '';
                                    return title ? ` · ${title}` : '';
                                  })()}
                                </span>
                                <time dateTime={new Date(entryRow.at).toISOString()}>
                                  {new Date(entryRow.at).toLocaleString()}
                                </time>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {status === 'revoked' ? (
                    <p className="field__note">Revoked. Existing copies keep the last synced values but stop updating.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="sec__card">
        <div className="sharing__head">
          <div>
            <h3 className="sec__title">Open a share</h3>
            <p className="sharing__meta">
              Paste the link, or type the short code and the owner’s address. Imports arrive as linked
              copies: the owner’s later edits replace the shared fields.
            </p>
          </div>
        </div>
        <div className="sharing__redeem">
          <div className="field">
            <label className="field__label" htmlFor="share-redeem-entry">Share link or code</label>
            <input
              id="share-redeem-entry"
              className="input"
              placeholder="https://…/s/K7M4-9Q2X-P8R3 or K7M4-9Q2X-P8R3"
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="share-redeem-host">Owner’s address (for a bare code)</label>
            <input
              id="share-redeem-host"
              className="input"
              placeholder="192.168.1.5:47821"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="share-redeem-pin">PIN, if one is required</label>
            <input
              id="share-redeem-pin"
              className="input input--port"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
            />
          </div>
          <button className="btn btn--primary" onClick={() => void redeem()} disabled={redeeming}>
            {redeeming ? <span className="spinner" /> : <ShareIcon width="14" height="14" />}
            Open share
          </button>
        </div>
        {redeemError ? <p className="sec__error">{redeemError}</p> : null}
        {redeemDone ? (
          <p className="sharing__done">
            <CheckIcon width="13" height="13" /> {redeemDone}
          </p>
        ) : null}
      </div>

      <div className="sec__card">
        <div className="sharing__head">
          <div>
            <h3 className="sec__title">Linked copies in this vault</h3>
            <p className="sharing__meta">
              Shared fields are replaced by the owner’s latest version. Your tags, favourite flag and other
              local details are kept.
            </p>
          </div>
          <button
            className="btn btn--secondary btn--sm"
            disabled={linked.length === 0 || shareSyncing}
            onClick={() => void onSyncShared?.()}
          >
            {shareSyncing ? <span className="spinner" /> : null} Sync now
          </button>
        </div>
        {linked.length === 0 ? (
          <p className="field__note">Nothing imported yet.</p>
        ) : (
          <ul className="sharing__linked">
            {linked.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title || 'Untitled login'}</strong>
                  <span>
                    From {item.shareLink?.shareName}
                    {item.shareLink?.endedAt ? ' · ended by owner' : ' · linked'}
                  </span>
                </div>
                <span className={`chip ${item.shareLink?.endedAt ? 'chip--muted' : 'chip--accent'}`}>
                  {item.shareLink?.endedAt ? 'ended' : 'live'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {form ? (
        <ShareForm
          key={form.mode === 'edit' ? form.share.id : 'new'}
          share={form.mode === 'edit' ? form.share : null}
          items={items}
          onSubmit={(values) =>
            form.mode === 'edit' ? submitEdit(form.share, values) : submitCreate(values)
          }
          onClose={() => setForm(null)}
        />
      ) : null}

      {revealedShare && revealedCode ? (
        <Modal
          title="Share code"
          onClose={() => setRevealShareId(null)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setRevealShareId(null)}>
                Done
              </button>
              {revealLink ? (
                <>
                  <button
                    className="btn btn--secondary"
                    onClick={() => getPlatform().openExternal(revealLink)}
                  >
                    <ExternalIcon width="14" height="14" /> Open in browser
                  </button>
                  <button
                    className="btn btn--primary"
                    onClick={() => void copy(revealLink, 'Link')}
                  >
                    <CopyIcon width="14" height="14" /> Copy link
                  </button>
                </>
              ) : null}
            </>
          }
        >
          <Alert tone="warn">
            This is the only time the code is shown. Colax stores only a hash. If you lose it, generate a
            new code, which disconnects the existing devices.
          </Alert>
          <div className="sharing__reveal">
            <span className="sharing__code-label">Short code</span>
            <code className="sharing__code-value sharing__code-value--large">
              {formatShareCode(revealedCode)}
            </code>
            <button
              className="btn btn--secondary"
              onClick={() => void copy(formatShareCode(revealedCode), 'Code')}
            >
              <CopyIcon width="13" height="13" /> Copy code
            </button>
          </div>
          {baseUrl ? (
            <div className="sharing__reveal">
              <span className="sharing__code-label">Full link</span>
              <code className="sharing__code-value">{revealLink}</code>
              <span className="field__note">
                The link includes the server address. A bare code still needs the owner’s address when it
                is typed into another device. Any browser can open this link; the Colax desktop app adds
                the linked copy that keeps updating.
              </span>
              {qr ? (
                <div className="sharing__qr">
                  <img src={qr} alt="QR code for the share link" />
                  <span className="field__note">Scan with a phone camera to open the browser view.</span>
                </div>
              ) : null}
            </div>
          ) : (
            <Alert tone="warn">
              No server address is available yet. Turn the sharing server on, or set a public address, then
              copy the link.
            </Alert>
          )}
          {!desktop ? (
            <Alert tone="info">
              The browser view works without the desktop app. Automatic linked-copy updates need the Colax
              desktop app on the recipient’s device.
            </Alert>
          ) : null}
        </Modal>
      ) : null}

      {confirmShare && confirmAction ? (
        <Modal
          title={
            confirmAction.kind === 'delete'
              ? 'Delete this share?'
              : confirmAction.kind === 'new-code'
                ? 'Generate a new code?'
                : 'Revoke this share?'
          }
          onClose={() => setConfirmAction(null)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button
                className={confirmAction.kind === 'delete' ? 'btn btn--danger' : 'btn btn--primary'}
                onClick={() => {
                  if (confirmAction.kind === 'delete') void deleteShare(confirmShare);
                  else if (confirmAction.kind === 'new-code') void newCode(confirmShare);
                  else void revokeShare(confirmShare);
                }}
              >
                {confirmAction.kind === 'delete'
                  ? 'Delete share'
                  : confirmAction.kind === 'new-code'
                    ? 'Generate new code'
                    : 'Revoke share'}
              </button>
            </>
          }
        >
          <p className="field__note">
            {confirmAction.kind === 'delete'
              ? 'Recipients keep their last synced copies, but they can no longer fetch updates. This cannot be undone.'
              : confirmAction.kind === 'new-code'
                ? 'The old code stops working immediately and every paired device is disconnected. Recipients keep their copies until you share the new code with them.'
                : 'New syncs stop immediately. Recipients keep the last synced values; they are not deleted from their vaults.'}
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function dateValue(timestamp: number | null): string {
  if (timestamp === null) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function endOfDate(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function ShareForm({
  share,
  items,
  onSubmit,
  onClose,
}: {
  share: VaultShare | null;
  items: VaultItem[];
  onSubmit: (values: ShareFormValues) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(share?.name ?? 'Shared logins');
  const [selected, setSelected] = useState<string[]>(
    (share?.itemIds ?? []).filter((id) => items.some((item) => item.id === id)),
  );
  const [expires, setExpires] = useState(dateValue(share?.expiresAt ?? null));
  const [maxUses, setMaxUses] = useState(share?.maxUses === null || share?.maxUses === undefined ? '' : String(share.maxUses));
  const [pinMode, setPinMode] = useState<'code' | 'pin'>(share?.auth ?? 'code');
  const [pin, setPin] = useState('');
  const [fields, setFields] = useState<ShareFields>(
    share?.fields ?? { notes: true, totp: false, attachments: false },
  );
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter(
        (item) =>
          !needle ||
          item.title.toLowerCase().includes(needle) ||
          item.username.toLowerCase().includes(needle) ||
          item.url.toLowerCase().includes(needle),
      )
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [items, query]);

  function toggle(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const message = await onSubmit({
        name,
        itemIds: selected,
        expiresAt: endOfDate(expires),
        maxUses: maxUses.trim() === '' ? null : Math.max(1, Math.round(Number(maxUses))),
        pinMode,
        pin,
        fields,
      });
      if (message) setError(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the share.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={share ? 'Edit share rules' : 'New share'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={busy || selected.length === 0}
          >
            {busy ? <span className="spinner" /> : null}
            {share ? 'Save rules' : 'Create share'}
          </button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field">
        <label className="field__label" htmlFor="share-name">Name</label>
        <input
          id="share-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Home server, work accounts…"
        />
      </div>

      <div className="field">
        <div className="sharing__field-head">
          <label className="field__label">Logins in this share</label>
          <span className="field__note">{selected.length} selected</span>
        </div>
        <div className="field-row">
          <input
            className="input"
            placeholder="Filter logins…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="btn btn--secondary btn--sm"
            onClick={() => setSelected((current) => [...new Set([...current, ...filtered.map((item) => item.id)])])}
          >
            Select shown
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
        <ul className="sharing__picker">
          {filtered.length === 0 ? (
            <li className="field__note">No matching logins.</li>
          ) : (
            filtered.map((item) => {
              const checked = selected.includes(item.id);
              return (
                <li key={item.id}>
                  <label className={`sharing__pick ${checked ? 'sharing__pick--on' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />
                    <span>
                      <strong>{item.title || 'Untitled login'}</strong>
                      <small>{item.username || item.url || 'No username'}</small>
                    </span>
                    {checked ? <CheckIcon width="13" height="13" /> : null}
                  </label>
                </li>
              );
            })
          )}
        </ul>
      </div>

      <div className="sharing__grid">
        <div className="field">
          <label className="field__label" htmlFor="share-expiry">Expires</label>
          <input
            id="share-expiry"
            className="input"
            type="date"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
          <span className="field__hint">Leave blank for no expiry.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="share-max-uses">Device limit</label>
          <input
            id="share-max-uses"
            className="input input--port"
            inputMode="numeric"
            placeholder="Unlimited"
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <span className="field__hint">How many devices may redeem the code.</span>
        </div>
        <div className="field">
          <label className="field__label">Protection</label>
          <Select
            label="Protection"
            value={pinMode}
            options={[
              { value: 'code', label: 'Code only', hint: 'Anyone with the 12-character code' },
              { value: 'pin', label: 'Code + PIN', hint: 'One more secret for the recipient' },
            ]}
            onChange={(next) => setPinMode(next === 'pin' ? 'pin' : 'code')}
          />
        </div>
        {pinMode === 'pin' ? (
          <div className="field">
            <label className="field__label" htmlFor="share-pin">PIN</label>
            <input
              id="share-pin"
              className="input input--port"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder={share?.auth === 'pin' ? 'Leave blank to keep' : '4–12 digits'}
            />
          </div>
        ) : null}
      </div>

      <div className="field">
        <span className="field__label">What the code exposes</span>
        <div className="sharing__checks">
          <label>
            <input
              type="checkbox"
              checked={fields.notes}
              onChange={(event) => setFields((current) => ({ ...current, notes: event.target.checked }))}
            />
            Notes
          </label>
          <label>
            <input
              type="checkbox"
              checked={fields.totp}
              onChange={(event) => setFields((current) => ({ ...current, totp: event.target.checked }))}
            />
            2FA seed
          </label>
          <label>
            <input
              type="checkbox"
              checked={fields.attachments}
              onChange={(event) =>
                setFields((current) => ({ ...current, attachments: event.target.checked }))
              }
            />
            Attachments
          </label>
        </div>
        <span className="field__hint">
          Username, password and website are always included. Notes are on by default; the two larger
          fields are opt-in.
        </span>
      </div>
    </Modal>
  );
}
