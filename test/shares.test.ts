import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ShareServer } from '../electron/share-server.ts';
import {
  DEFAULT_SHARE_FIELDS,
  formatShareCode,
  isShareCode,
  normaliseShareCode,
  parseShareEntry,
  shareIsActive,
  shareStatus,
  type VaultShare,
} from '../src/lib/shares.ts';
import { emptyItem } from '../src/vault/types.ts';
import {
  buildShareSnapshots,
  createShareRecord,
  hashShareCode,
  hashPin,
  makeShareCode,
  nextShareRevision,
  normalisePin,
  sharedLoginFromItem,
  verifyPinHash,
} from '../src/vault/shares.ts';

function sampleItem(id = 'login-1') {
  return {
    ...emptyItem(id, 1_700_000_000_000),
    title: 'Bank <script>alert(1)</script>',
    username: 'ada@example.com',
    password: 'pässwörd-<b>',
    url: 'https://bank.example.com/login',
    notes: 'A note with <b>markup</b> and an ampersand &',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    updatedAt: 1_700_000_000_000,
  };
}

test('share codes tolerate display grouping and reject bad characters', () => {
  const code = makeShareCode().code;
  assert.equal(code.length, 12);
  assert.equal(isShareCode(code), true);
  assert.equal(normaliseShareCode(formatShareCode(code)), code);
  assert.equal(isShareCode('OOOO-OOOO-OOOO'), false);
  assert.deepEqual(parseShareEntry(`https://host:47821/s/${formatShareCode(code)}`), {
    code,
    baseUrl: 'https://host:47821',
  });
  assert.deepEqual(parseShareEntry(`${formatShareCode(code)}@192.168.1.5:47821`), {
    code,
    baseUrl: 'http://192.168.1.5:47821',
  });
});

test('a share stores only a hash and a PBKDF2 PIN', async () => {
  const code = makeShareCode().code;
  const share = await createShareRecord({
    name: 'Work',
    code,
    pin: '4821',
    itemIds: ['login-1'],
    maxUses: 3,
    expiresAt: null,
  });
  assert.equal(share.auth, 'pin');
  assert.notEqual(share.codeHash, code);
  assert.equal(share.codeHash, await hashShareCode(code));
  assert.equal(share.pinHash.length, 64);
  assert.equal(await verifyPinHash('4821', share.pinHash, share.pinSalt, share.pinIterations), true);
  assert.equal(await verifyPinHash('0000', share.pinHash, share.pinSalt, share.pinIterations), false);
  assert.equal(shareStatus(share), 'active');
  assert.equal(shareIsActive(share), true);
  assert.equal(share.uses, 0);
  const pin = await hashPin('1234');
  assert.equal(pin.hash.length, 64);
  assert.equal(normalisePin(' 12-34x'), '1234');
});

test('snapshots obey the exposed-fields rules', () => {
  const item = sampleItem();
  const share = {
    fields: { ...DEFAULT_SHARE_FIELDS, notes: false, totp: true },
  } as VaultShare;
  const shared = sharedLoginFromItem(item, share.fields);
  assert.equal(shared.notes, '');
  assert.equal(shared.totpSecret, item.totpSecret);
  assert.deepEqual(shared.attachments, []);
  const snapshots = buildShareSnapshots([{ ...share, itemIds: [item.id] } as VaultShare], [item]);
  assert.equal(snapshots[0]?.items[0]?.title, item.title);
  assert.equal(snapshots[0]?.items[0]?.password, item.password);
});

test('the share server pairs devices, propagates edits and honours revocation', async () => {
  const server = new ShareServer();
  const item = sampleItem();
  const code = makeShareCode().code;
  const created = await createShareRecord({
    name: 'Home',
    code,
    pin: '4821',
    itemIds: [item.id],
  });
  let share = created;

  try {
    const status = await server.start({
      enabled: true,
      port: 0,
      bind: 'local',
      publicUrl: '',
    });
    assert.equal(status.running, true);
    const base = status.localUrl;
    const pathCode = encodeURIComponent(formatShareCode(code));

    const beforeSync = await fetch(`${base}/s/${pathCode}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '4821', deviceId: 'dev-1', deviceName: 'Laptop' }),
    });
    assert.equal(beforeSync.status, 404);
    assert.equal((await beforeSync.json() as { ended?: boolean }).ended, true);

    server.sync([{ share, items: [sharedLoginFromItem(item, share.fields)] }]);

    const wrongPin = await fetch(`${base}/s/${pathCode}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '0000', deviceId: 'dev-1', deviceName: 'Laptop' }),
    });
    assert.equal(wrongPin.status, 403);

    const redeemed = await fetch(`${base}/s/${pathCode}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '4821', deviceId: 'dev-1', deviceName: 'Laptop' }),
    });
    assert.equal(redeemed.status, 200);
    const redeemedBody = await redeemed.json() as {
      ok: boolean;
      deviceToken: string;
      items: { password: string }[];
    };
    assert.equal(redeemedBody.ok, true);
    assert.ok(redeemedBody.deviceToken.length > 20);
    assert.equal(redeemedBody.items[0]?.password, item.password);

    const noToken = await fetch(`${base}/s/${pathCode}/sync`);
    assert.equal(noToken.status, 401);

    const synced = await fetch(`${base}/s/${pathCode}/sync`, {
      headers: { authorization: `Bearer ${redeemedBody.deviceToken}` },
    });
    assert.equal(synced.status, 200);
    assert.equal((await synced.json() as { items: { title: string }[] }).items[0]?.title, item.title);

    // Owner edits, and the next pull sees the new password. The renderer now
    // knows the device from the event, so its snapshot carries the same hash.
    const tokenHash = createHash('sha256').update(redeemedBody.deviceToken).digest('hex');
    share = nextShareRevision({
      ...share,
      uses: 1,
      devices: [
        {
          id: 'dev-1',
          name: 'Laptop',
          tokenHash,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          lastIp: '127.0.0.1',
          userAgent: 'test',
          revokedAt: null,
        },
      ],
    });
    const editedItem = { ...item, password: 'new-password', updatedAt: item.updatedAt + 1 };
    server.sync([{ share, items: [sharedLoginFromItem(editedItem, share.fields)] }]);
    const afterEdit = await fetch(`${base}/s/${pathCode}/sync`, {
      headers: { authorization: `Bearer ${redeemedBody.deviceToken}` },
    });
    assert.equal((await afterEdit.json() as { items: { password: string }[] }).items[0]?.password, 'new-password');

    // The browser view is PIN-gated, escaped, and carries the strict policy.
    const gate = await fetch(`${base}/s/${pathCode}`);
    assert.equal(gate.status, 200);
    const gateHtml = await gate.text();
    assert.ok(gateHtml.includes('Enter PIN'));
    const csrf = /name="csrf" value="([^"]+)"/.exec(gateHtml)?.[1] ?? '';
    const gateCookie = (gate.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(csrf && gateCookie.startsWith('colax_gate='));

    const auth = await fetch(`${base}/s/${pathCode}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: gateCookie,
      },
      body: new URLSearchParams({ csrf, pin: '4821' }),
    });
    assert.equal(auth.status, 303);
    const sessionCookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const page = await fetch(`${base}/s/${pathCode}`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.ok((await page.text()).includes('Bank &lt;script&gt;alert(1)&lt;/script&gt;'));

    const itemPage = await fetch(`${base}/s/${pathCode}/logins/${encodeURIComponent(item.id)}`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(itemPage.status, 200);
    const html = await itemPage.text();
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.ok(html.includes('&lt;b&gt;markup&lt;/b&gt;'));

    // Revocation stops the next sync but returns a distinct "ended" answer.
    share = nextShareRevision({ ...share, revokedAt: Date.now() });
    server.sync([{ share, items: [sharedLoginFromItem(editedItem, share.fields)] }]);
    const revoked = await fetch(`${base}/s/${pathCode}/sync`, {
      headers: { authorization: `Bearer ${redeemedBody.deviceToken}` },
    });
    assert.equal(revoked.status, 410);
    assert.equal((await revoked.json() as { ended: boolean }).ended, true);

    // Deleting the share gives the recipient an ending rather than a retry loop.
    server.sync([]);
    const deleted = await fetch(`${base}/s/${pathCode}/sync`, {
      headers: { authorization: `Bearer ${redeemedBody.deviceToken}` },
    });
    assert.equal(deleted.status, 404);
    assert.equal((await deleted.json() as { ended: boolean }).ended, true);
  } finally {
    await server.stop();
  }
});

test('a new code disconnects the old devices and resets the use count', async () => {
  const server = new ShareServer();
  const item = sampleItem('login-3');
  const oldCode = makeShareCode().code;
  const newCode = makeShareCode().code;
  const share = await createShareRecord({
    name: 'Rotating',
    code: oldCode,
    pin: '',
    itemIds: [item.id],
    maxUses: 1,
  });
  try {
    const status = await server.start({ enabled: true, port: 0, bind: 'local', publicUrl: '' });
    server.sync([{ share, items: [sharedLoginFromItem(item, share.fields)] }]);
    const oldPath = encodeURIComponent(formatShareCode(oldCode));
    const newPath = encodeURIComponent(formatShareCode(newCode));
    const redeemed = await fetch(`${status.localUrl}/s/${oldPath}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-old', deviceName: 'Old phone' }),
    });
    const oldToken = (await redeemed.json() as { deviceToken: string }).deviceToken;

    server.sync([
      {
        share: nextShareRevision({
          ...share,
          codeHash: await hashShareCode(newCode),
          devices: [],
          uses: 0,
        }),
        items: [sharedLoginFromItem(item, share.fields)],
      },
    ]);

    const oldLink = await fetch(`${status.localUrl}/s/${oldPath}/sync`, {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    assert.equal(oldLink.status, 404);
    assert.equal((await oldLink.json() as { ended: boolean }).ended, true);

    const oldTokenOnNew = await fetch(`${status.localUrl}/s/${newPath}/sync`, {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    assert.equal(oldTokenOnNew.status, 401);
    assert.equal((await oldTokenOnNew.json() as { ended: boolean }).ended, true);

    const fresh = await fetch(`${status.localUrl}/s/${newPath}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-new', deviceName: 'New phone' }),
    });
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json() as { ok: boolean }).ok, true);
  } finally {
    await server.stop();
  }
});

test('a max-use share refuses the next device', async () => {
  const server = new ShareServer();
  const item = sampleItem('login-2');
  const code = makeShareCode().code;
  const share = await createShareRecord({
    name: 'One use',
    code,
    pin: '',
    itemIds: [item.id],
    maxUses: 1,
  });
  try {
    const status = await server.start({ enabled: true, port: 0, bind: 'local', publicUrl: '' });
    server.sync([{ share, items: [sharedLoginFromItem(item, share.fields)] }]);
    const pathCode = encodeURIComponent(formatShareCode(code));
    const first = await fetch(`${status.localUrl}/s/${pathCode}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', deviceName: 'Phone' }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${status.localUrl}/s/${pathCode}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-b', deviceName: 'Tablet' }),
    });
    assert.equal(second.status, 410);
    assert.equal((await second.json() as { ended: boolean }).ended, true);
  } finally {
    await server.stop();
  }
});
