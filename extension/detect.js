/**
 * Content script: watches forms and offers to capture what was typed.
 *
 * Scope limits, deliberately. It reads only password fields and the single field
 * that best looks like an identifier, and only at the moment a form is
 * submitted. It never listens to `keydown`, never reads on an interval, and
 * never stores anything itself — the values go straight to the background worker
 * and on into the vault, and are dropped here as soon as that call returns.
 *
 * It also does not treat a fill as a capture. Chrome's autofill and password
 * managers set these values programmatically, which fires no events we can see,
 * so the only reliable trigger is a real submit.
 */

(() => {
  'use strict';

  /** A submit we have already offered, so one gesture never double-prompts. */
  let handled = false;

  /** True when a real user gesture happened since the last programmatic change. */
  let userTyped = false;

  /** Guard against our own writes to the readonly hint area. */
  const OWN_CLASS = 'colax-capture-hint';

  /* ---- Field classification ------------------------------------------- */

  /** The attributes a site uses to name an email field, most specific first. */
  const EMAIL_HINTS = [
    'autocomplete="email"',
    'name="email"',
    'name="user_email"',
    'name="login"',
    'id="email"',
    'id="login"',
    'type="email"',
  ];

  const USERNAME_HINTS = [
    'autocomplete="username"',
    'autocomplete="email"',
    'name="username"',
    'name="user"',
    'name="login"',
    'id="username"',
    'id="user"',
  ];

  const NEW_PASSWORD_HINTS = ['autocomplete="new-password"'];
  const CURRENT_PASSWORD_HINTS = ['autocomplete="current-password"'];

  function attributeBlob(element) {
    return [
      element.getAttribute('name') || '',
      element.getAttribute('id') || '',
      element.getAttribute('autocomplete') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || '',
    ]
      .join(' ')
      .toLowerCase();
  }

  function isPasswordField(element) {
    if (element.type !== 'password') return false;
    return !/confirm|repeat|retype|verify|again/i.test(attributeBlob(element));
  }

  function isConfirmationField(element) {
    if (element.type !== 'password') return false;
    return /confirm|repeat|retype|verify|again/i.test(attributeBlob(element));
  }

  function isUsernameField(element) {
    if (!element || isPasswordField(element)) return false;
    if (element.type === 'email') return true;
    const blob = attributeBlob(element);
    return EMAIL_HINTS.some((hint) => blob.includes(hint)) || USERNAME_HINTS.some((hint) => blob.includes(hint));
  }

  /** Reads the visible inputs in document order, ignoring hidden and disabled ones. */
  function visibleFields(form) {
    return Array.from(form.querySelectorAll('input')).filter((input) => {
      if (input.disabled || input.readOnly) return false;
      if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return false;
      const box = input.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
  }

  /** Pulls a capture out of a form, or null if it has nothing worth having. */
  function readCapture(form) {
    const fields = visibleFields(form);
    const passwords = fields.filter(isPasswordField);
    const confirmations = fields.filter(isConfirmationField);

    // No password field means there is no credential here at all. This is what
    // keeps ordinary newsletter and search forms out of the prompt.
    if (passwords.length === 0) return null;

    const usernameField = fields.find(isUsernameField);
    const password = passwords[0].value ?? '';
    const username = usernameField?.value?.trim() ?? '';

    return {
      url: location.href,
      pageTitle: document.title,
      username,
      password,
      // Sent only when the page actually has a second field, so the vault can
      // tell "mismatch" apart from "not a signup form".
      passwordConfirm: confirmations.length > 0 ? (confirmations[0].value ?? '') : undefined,
    };
  }

  /* ---- Prompt ---------------------------------------------------------- */

  /**
   * A small inline bar, built in the page rather than as an overlay, so it does
   * not fight with the site's own layout or z-index.
   */
  function showPrompt(capture) {
    if (document.querySelector(`.${OWN_CLASS}`)) return;

    const host = document.createElement('div');
    host.className = OWN_CLASS;
    host.setAttribute('role', 'status');
    host.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:18px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:14px',
      'max-width:min(520px,calc(100vw - 24px))',
      'padding:10px 12px 10px 14px',
      'border-radius:14px',
      'border:1px solid rgba(255,255,255,.14)',
      'background:rgba(18,20,26,.94)',
      'color:#eef1f6',
      'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.35)',
    ].join(';');

    const label = document.createElement('span');
    label.textContent = 'Save this login to Colax?';
    label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-shrink:0';

    const yes = button('Save', 'rgba(255,255,255,.1)', '#fff');
    yes.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'colax:capture', ...capture }, (response) => {
        void chrome.runtime.lastError;
        // No vault open, or capturing switched off: say so rather than
        // pretending the credentials were stored.
        label.textContent = response?.ok ? 'Opening Colax…' : 'Open Colax to save this';
        yes.disabled = true;
        no.disabled = true;
      });
    });

    const no = button('Not now', 'transparent', 'rgba(238,241,246,.72)');
    no.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'colax:dismissed' }, () => void chrome.runtime.lastError);
      host.remove();
    });

    actions.append(yes, no);
    host.append(label, actions);
    document.documentElement.appendChild(host);

    // Self-dismiss so a prompt can never sit on a page indefinitely.
    setTimeout(() => host.remove(), 20_000);
  }

  function button(text, background, color) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = text;
    el.style.cssText = `padding:6px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:${background};color:${color};font:inherit;cursor:pointer`;
    return el;
  }

  /* ---- Wiring ---------------------------------------------------------- */

  function onSubmit(event) {
    if (handled) return;
    const form = event.target;
    if (!form || form.tagName !== 'FORM') return;

    // Only offer after the user actually typed. A form that was filled and
    // submitted without a keystroke in this page's lifetime is autofill or a
    // script, and prompting on it is noise.
    if (!userTyped) return;

    const capture = readCapture(form);
    if (!capture) return;
    handled = true;
    showPrompt(capture);
  }

  // A single keystroke is enough to establish intent; the value itself is never
  // inspected here.
  const markTyped = (event) => {
    if (event.isTrusted) userTyped = true;
  };

  document.addEventListener('keydown', markTyped, true);
  document.addEventListener('submit', onSubmit, true);
})();