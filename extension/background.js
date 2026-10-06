/**
 * Background service worker.
 *
 * Deliberately thin. It holds no captured values and does no interpretation; it
 * relays a message from a page to whichever Colax tab is open, and knows how to
 * focus one. The thinking all happens inside the vault app, where the catalogue
 * and the crypto already live, so a captured password never passes through code
 * that is not the vault's own.
 */

const COLAX_ORIGIN = process.env.COLAX_ORIGIN ?? 'http://localhost:5173';

/** Finds an open Colax tab, optionally creating one. */
async function findVaultTab(create = false) {
  const url = `${COLAX_ORIGIN}/`;
  const existing = await chrome.tabs.query({ url: `${COLAX_ORIGIN}/*` });
  if (existing.length > 0) return existing[0];
  if (!create) return null;
  return chrome.tabs.create({ url, active: true });
}

/** Pushes a payload at a tab and resolves true if something answered. */
function send(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      // Reading lastError stops Chrome logging it when nothing is listening,
      // which is the normal case: the user simply has no vault open.
      void chrome.runtime.lastError;
      resolve(Boolean(response));
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // Capturing is opt-in per site pattern. Nothing is ever sent until the user
  // turns it on, which is why the default set is empty.
  chrome.storage.sync.get({ enabled: false, sites: [], dismissed: [] }, (stored) => {
    chrome.storage.sync.set({ enabled: Boolean(stored.enabled), sites: stored.sites ?? [] });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // A page has a credential to offer.
  if (message.type === 'colax:capture') {
    void handleCapture(message, sender, sendResponse);
    return true; // keep the channel open for the async reply
  }

  // The in-page prompt was dismissed; remember it so we do not nag on that site.
  if (message.type === 'colax:dismissed') {
    const host = safeHost(sender);
    if (host) {
      chrome.storage.sync.get({ dismissed: [] }, (stored) => {
        const list = stored.dismissed ?? [];
        chrome.storage.sync.set({ dismissed: [...new Set([...list, host])].slice(-200) });
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'colax:open-vault') {
    void findVaultTab(true).then((tab) => sendResponse({ ok: Boolean(tab), tabId: tab?.id }));
    return true;
  }

  return false;
});

async function handleCapture(message, sender, sendResponse) {
  const host = safeHost(sender);
  const url = typeof message.url === 'string' ? message.url : sender?.tab?.url;
  if (!host || !url) {
    sendResponse({ ok: false, reason: 'no-host' });
    return;
  }

  const { enabled, sites, dismissed } = await chrome.storage.sync.get({
    enabled: false,
    sites: [],
    dismissed: [],
  });

  if (!enabled || sites.length === 0) {
    sendResponse({ ok: false, reason: 'disabled' });
    return;
  }
  // A site the user said no to stays a no until they clear the list.
  if ((dismissed ?? []).includes(host)) {
    sendResponse({ ok: false, reason: 'dismissed' });
    return;
  }

  const tab = await findVaultTab();
  if (!tab?.id) {
    // No vault open. The in-page prompt still appears so the user knows a
    // capture is available, but there is nowhere to put it yet.
    sendResponse({ ok: false, reason: 'no-vault' });
    return;
  }

  const delivered = await send(tab.id, {
    type: 'colax:offer',
    capture: {
      url,
      host,
      pageTitle: typeof message.pageTitle === 'string' ? message.pageTitle : '',
      username: typeof message.username === 'string' ? message.username : '',
      password: typeof message.password === 'string' ? message.password : '',
      passwordConfirm: typeof message.passwordConfirm === 'string' ? message.passwordConfirm : '',
    },
  });

  sendResponse({ ok: delivered });
}

/** The host of the page that sent this, never a value the page chose itself. */
function safeHost(sender) {
  try {
    return new URL(sender?.tab?.url ?? '').hostname || null;
  } catch {
    return null;
  }
}

// Opening the popup-less action just focuses the vault.
chrome.action.onClicked.addListener(async () => {
  const tab = await findVaultTab(true);
  if (tab?.id) chrome.tabs.update(tab.id, { active: true });
});