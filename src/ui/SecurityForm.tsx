import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  answerTooWeak,
  extractTotpSeed,
  generateTotpSeed,
  hashAnswer,
  hashPasscode,
  passcodeTooWeak,
  securityLevel,
  verifyAnswer,
  verifyPasscode,
  verifyTotp,
  type LoginSecurity,
  type SecurityQuestion,
} from '../crypto/security.ts';
import { PlusIcon, TrashIcon, XIcon } from './icons.tsx';
import { Modal, Select } from './primitives.tsx';

/** The authenticator URI a phone app scans. */
export function otpauthUrl(seed: string, label: string): string {
  return `otpauth://totp/Colax:${encodeURIComponent(label || 'vault')}?secret=${seed}&issuer=Colax`;
}

/**
 * Shared editor for an optional second factor: a TOTP seed (with a scannable
 * QR code) and/or hashed recovery questions. Used for a single login, a whole
 * folder, and the vault itself, so all three read the same way.
 */
export function SecurityForm({
  security,
  onChange,
  onNotify,
  label,
}: {
  security: LoginSecurity;
  onChange: (next: LoginSecurity) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
  /** Goes into the QR payload, e.g. the login's name. */
  label: string;
}) {
  const [seedInput, setSeedInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [qr, setQr] = useState('');

  /**
   * A seed the user generated or pasted but has not confirmed yet.
   *
   * This is the whole fix for the phantom gate. Generating or attaching used to
   * call onChange immediately, so the factor was live — and gating logins, the
   * folder, or the whole vault — before any code had ever verified it. Clicking
   * "Generate a key" out of curiosity armed a demand for codes from an
   * authenticator that was never configured, with no way back except removing
   * the factor (which itself requires passing the gate). Now nothing is saved
   * until a code proves the seed works; walking away leaves no trace.
   */
  const [stagedSeed, setStagedSeed] = useState<string | null>(null);
  // The seed under test: a staged one while confirming, otherwise the saved one.
  const activeSeed = stagedSeed ?? security.totp?.seed ?? null;

  // No live "code now" display anywhere in this editor — not for saved keys
  // and not while staging a new one either. Typing a code from the phone app
  // into the check field below is what confirms a key works; showing the code
  // here would just leak it onto a screen meant for changing things.

  useEffect(() => {
    if (!activeSeed) return;
    let cancelled = false;
    void QRCode.toDataURL(otpauthUrl(activeSeed, label), { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQr(url);
    }).catch(() => {
      if (!cancelled) setQr('');
    });
    return () => {
      cancelled = true;
    };
  }, [activeSeed, label]);

  async function attachSeed() {
    const seed = extractTotpSeed(seedInput);
    if (!seed) {
      onNotify('That does not look like an authenticator key', 'error');
      return;
    }
    // Staged, not saved: the factor only becomes real once a code confirms it.
    setStagedSeed(seed);
    setSeedInput('');
    setCodeInput('');
    setCodeError('');
  }

  async function generate() {
    const seed = generateTotpSeed();
    setStagedSeed(seed);
    setCodeInput('');
    setCodeError('');
    onNotify('Scan the code, then confirm one to keep the key');
  }

  async function confirmCode() {
    if (!activeSeed) return;
    const ok = await verifyTotp(activeSeed, codeInput);
    if (!ok) {
      setCodeError('That code did not match. Check the clock on this device.');
      return;
    }
    setCodeError('');
    if (stagedSeed) {
      // First successful confirmation is what saves the key. Until this line
      // runs, nothing about the login, folder or vault has changed.
      onChange({ ...security, totp: { seed: stagedSeed } });
      setStagedSeed(null);
      onNotify('Authenticator key saved');
    } else {
      onNotify('Authenticator confirmed');
    }
  }

  function detach() {
    onChange({ ...security, totp: null });
    setStagedSeed(null);
    setCodeInput('');
    setQr('');
    onNotify('Authenticator removed');
  }

  function discardStaged() {
    setStagedSeed(null);
    setCodeInput('');
    setCodeError('');
    setQr('');
  }

  const [newPrompt, setNewPrompt] = useState(QUESTION_PROMPTS[0] ?? '');
  const [newAnswer, setNewAnswer] = useState('');
  const [answerError, setAnswerError] = useState('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkInput, setCheckInput] = useState('');

  const [passcodeDraft, setPasscodeDraft] = useState('');
  const [passcodeConfirm, setPasscodeConfirm] = useState('');
  const [passcodeError, setPasscodeError] = useState('');
  const [passcodeCheck, setPasscodeCheck] = useState('');

  async function savePasscode() {
    if (passcodeTooWeak(passcodeDraft)) {
      setPasscodeError('Use at least 8 characters, and mix letters, numbers or symbols. Not "password".');
      return;
    }
    if (passcodeDraft !== passcodeConfirm) {
      setPasscodeError('Those two do not match.');
      return;
    }
    // Refuse to make the gate the credential itself: that would be security
    // theatre, since anyone who can open the login can then read the gate.
    if (security.totp && passcodeDraft.length < 12) {
      setPasscodeError('With an authenticator already set, use at least 12 characters.');
      return;
    }
    const stored = await hashPasscode(passcodeDraft);
    onChange({ ...security, passcode: stored });
    setPasscodeDraft('');
    setPasscodeConfirm('');
    setPasscodeError('');
    onNotify('Passcode saved');
  }

  async function confirmPasscode() {
    if (!security.passcode) return;
    const ok = await verifyPasscode(security.passcode, passcodeCheck);
    if (ok) {
      onNotify('Passcode confirmed');
      setPasscodeCheck('');
      setPasscodeError('');
    } else {
      setPasscodeError('That does not match the stored passcode.');
    }
  }

  async function addQuestion() {
    if (!newPrompt.trim()) return;
    if (answerTooWeak(newAnswer)) {
      setAnswerError('Use something a stranger could not guess, not a single word or "yes".');
      return;
    }
    const { hash, salt } = await hashAnswer(newAnswer);
    const question: SecurityQuestion = {
      id: `sq_${Math.random().toString(36).slice(2, 10)}`,
      prompt: newPrompt.trim(),
      hash,
      salt,
    };
    onChange({ ...security, questions: [...security.questions, question] });
    setNewAnswer('');
    setAnswerError('');
    onNotify('Recovery question added');
  }

  function removeQuestion(id: string) {
    onChange({ ...security, questions: security.questions.filter((question) => question.id !== id) });
    setCheckingId(null);
  }

  async function checkQuestion(question: SecurityQuestion) {
    if (checkingId === question.id) {
      const ok = await verifyAnswer(question, checkInput);
      if (ok) {
        onNotify('Answer confirmed');
        setCheckingId(null);
        setCheckInput('');
      } else {
        setAnswerError('That does not match the stored answer.');
      }
      return;
    }
    setCheckingId(question.id);
    setCheckInput('');
    setAnswerError('');
  }

  const level = securityLevel(security);

  // Mini-tabs: one factor visible at a time. Stacking authenticator, passcode,
  // questions and passkey in one scroll buried the setup that mattered, and
  // the QR code pushed everything else a screen away. The tiles above double as
  // the tabs — status and navigation in one row.
  const [tab, setTab] = useState<'authenticator' | 'passcode' | 'questions' | 'passkey'>('authenticator');

  return (
    <div className="sec sec--summary">
      {/* The status and the two factors that matter, up front. The three cards
          below are for setup and repair; the common case is "is this login
          protected, and by what", which used to require reading past a paragraph
          and a QR code to answer. */}
      <div className="sec__intro">
        <p className="sec__lead">
          Optional. With nothing here, this works exactly as before. With something here, it gates access.
        </p>
        <span className="sec__state" data-level={level}>
          {level === 'none' ? 'No second factor' : level === 'partial' ? 'Partly protected' : 'Protected'}
        </span>
      </div>

      <div className="sec__tabs" role="tablist" aria-label="Second factor">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'authenticator'}
          className="sec__glance"
          data-on={Boolean(security.totp) || undefined}
          data-active={tab === 'authenticator' || undefined}
          onClick={() => setTab('authenticator')}
        >
          <span className="sec__glance-icon" aria-hidden="true">
            <ShieldGlyph />
          </span>
          <span className="sec__glance-body">
            <span className="sec__glance-title">Authenticator</span>
            <span className="sec__glance-note">
              {security.totp ? 'Key attached — a code is needed' : 'Not set'}
            </span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'passcode'}
          className="sec__glance"
          data-on={Boolean(security.passcode) || undefined}
          data-active={tab === 'passcode' || undefined}
          onClick={() => setTab('passcode')}
        >
          <span className="sec__glance-icon" aria-hidden="true">
            <KeyGlyph />
          </span>
          <span className="sec__glance-body">
            <span className="sec__glance-title">Passcode</span>
            <span className="sec__glance-note">
              {security.passcode ? 'Set — it gates this login' : 'Not set'}
            </span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'questions'}
          className="sec__glance"
          data-on={security.questions.length > 0 || undefined}
          data-active={tab === 'questions' || undefined}
          onClick={() => setTab('questions')}
        >
          <span className="sec__glance-icon" aria-hidden="true">
            <QuestionGlyph />
          </span>
          <span className="sec__glance-body">
            <span className="sec__glance-title">Recovery</span>
            <span className="sec__glance-note">
              {security.questions.length === 0
                ? 'Not set'
                : `${security.questions.length} question${security.questions.length === 1 ? '' : 's'}`}
            </span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'passkey'}
          className="sec__glance"
          data-active={tab === 'passkey' || undefined}
          onClick={() => setTab('passkey')}
        >
          <span className="sec__glance-icon" aria-hidden="true">
            <PasskeyGlyph />
          </span>
          <span className="sec__glance-body">
            <span className="sec__glance-title">Passkey</span>
            <span className="sec__glance-note">Unavailable here</span>
          </span>
        </button>
      </div>

      {tab === 'authenticator' ? (
      <section className="sec__card" role="tabpanel">
        <header className="sec__head">
          <h3 className="sec__title">Authenticator app</h3>
          {security.totp && !stagedSeed ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={detach}>
              Remove
            </button>
          ) : null}
          {stagedSeed ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={discardStaged}>
              Discard
            </button>
          ) : null}
        </header>

        {stagedSeed ? (
          <p className="sec__pending" role="status">
            Not saved yet. Confirm a code below and the key is kept; leave without confirming and nothing changes.
          </p>
        ) : null}

        {activeSeed ? (
          <>
            {qr ? (
              <div className="sec__qr">
                <img src={qr} alt="Scan this QR code with your authenticator app" width={220} height={220} />
                <p className="field__note">Scan this with your authenticator app, then confirm a code below.</p>
              </div>
            ) : null}
            <div className="field-row">
              <input
                className="input"
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter a code to check"
                inputMode="numeric"
                aria-label="Authenticator code"
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void confirmCode()}
                disabled={codeInput.length !== 6}
              >
                Check
              </button>
            </div>
            {codeError ? <p className="sec__error">{codeError}</p> : null}
          </>
        ) : (
          <>
            <div className="field-row">
              <button type="button" className="btn btn--primary" onClick={() => void generate()}>
                <PlusIcon width="14" height="14" />
                Generate a key
              </button>
            </div>
            <div className="field-row">
              <input
                className="input input--mono"
                value={seedInput}
                onChange={(event) => setSeedInput(event.target.value)}
                placeholder="Or paste the setup key / otpauth:// link"
                spellCheck={false}
                aria-label="Authenticator setup key"
              />
              <button type="button" className="btn btn--secondary" onClick={() => void attachSeed()} disabled={!seedInput.trim()}>
                Attach
              </button>
            </div>
            <p className="field__note">Generating one here and scanning the QR code is the easiest path.</p>
          </>
        )}
      </section>
      ) : null}

      {tab === 'passcode' ? (
      <section className="sec__card" role="tabpanel">
        <header className="sec__head">
          <h3 className="sec__title">Passcode</h3>
          {security.passcode ? (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                onChange({ ...security, passcode: null });
                setPasscodeCheck('');
                setPasscodeError('');
                onNotify('Passcode removed');
              }}
            >
              Remove
            </button>
          ) : null}
        </header>
        <p className="field__note">
          A password of your own that gates this login. Stored hashed, so it is never written to disk in the
          clear. It must not be the same as the login's own password.
        </p>

        {security.passcode ? (
          <div className="field-row">
            <input
              className="input"
              type="password"
              value={passcodeCheck}
              autoComplete="off"
              onChange={(event) => setPasscodeCheck(event.target.value)}
              placeholder="Enter it to check"
              aria-label="Passcode"
            />
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void confirmPasscode()}
              disabled={!passcodeCheck}
            >
              Check
            </button>
          </div>
        ) : (
          <>
            <div className="field-row">
              <input
                className="input"
                type="password"
                value={passcodeDraft}
                autoComplete="new-password"
                onChange={(event) => {
                  setPasscodeDraft(event.target.value);
                  setPasscodeError('');
                }}
                placeholder="New passcode"
                aria-label="New passcode"
              />
              <input
                className="input"
                type="password"
                value={passcodeConfirm}
                autoComplete="new-password"
                onChange={(event) => {
                  setPasscodeConfirm(event.target.value);
                  setPasscodeError('');
                }}
                placeholder="Repeat it"
                aria-label="Repeat passcode"
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void savePasscode()}
                disabled={!passcodeDraft || !passcodeConfirm}
              >
                Set
              </button>
            </div>
          </>
        )}
        {passcodeError ? <p className="sec__error">{passcodeError}</p> : null}
      </section>
      ) : null}

      {tab === 'questions' ? (
      <section className="sec__card" role="tabpanel">
        <header className="sec__head">
          <h3 className="sec__title">Recovery questions</h3>
        </header>
        <p className="field__note">
          Answers are hashed with a salt and never stored. Pick something you could reconstruct and nobody else could guess.
        </p>

        {security.questions.length > 0 ? (
          <ul className="sec__questions">
            {security.questions.map((question) => (
              <li key={question.id}>
                <div className="sec__question">
                  <span className="sec__prompt">{question.prompt}</span>
                  <span className="sec__answered">answer hashed</span>
                </div>
                {checkingId === question.id ? (
                  <div className="field-row">
                    <input
                      className="input"
                      value={checkInput}
                      onChange={(event) => setCheckInput(event.target.value)}
                      placeholder="Your answer"
                      aria-label={`Answer to ${question.prompt}`}
                      autoFocus
                    />
                    <button type="button" className="btn btn--secondary" onClick={() => void checkQuestion(question)}>
                      Verify
                    </button>
                    <button type="button" className="btn btn--icon" onClick={() => setCheckingId(null)} aria-label="Cancel">
                      <XIcon />
                    </button>
                  </div>
                ) : (
                  <div className="sec__question-actions">
                    <button type="button" className="btn btn--quiet btn--sm" onClick={() => void checkQuestion(question)}>
                      Check answer
                    </button>
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      onClick={() => removeQuestion(question.id)}
                      aria-label={`Remove question: ${question.prompt}`}
                    >
                      <TrashIcon width="13" height="13" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="sec__add">
          <div className="field-row">
            <Select
              label="Question"
              value={newPrompt}
              options={QUESTION_PROMPTS.map((prompt) => ({ value: prompt, label: prompt }))}
              onChange={(next) => setNewPrompt(next)}
            />
          </div>
          <div className="field-row">
            <input
              className="input"
              value={newAnswer}
              onChange={(event) => {
                setNewAnswer(event.target.value);
                setAnswerError('');
              }}
              placeholder="Your answer"
              aria-label="Answer"
            />
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void addQuestion()}
              disabled={!newAnswer.trim()}
            >
              <PlusIcon width="14" height="14" />
              Add
            </button>
          </div>
          {answerError ? <p className="sec__error">{answerError}</p> : null}
        </div>
      </section>
      ) : null}

      {tab === 'passkey' ? (
      <section className="sec__card" data-disabled role="tabpanel">
        <header className="sec__head">
          <h3 className="sec__title">Passkey</h3>
          <span className="sec__badge">Not available here</span>
        </header>
        <p className="field__note">{PASSKEY_REASON}</p>
      </section>
      ) : null}
    </div>
  );
}

function PasskeyGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="9" width="13" height="10" rx="2.5" />
      <path d="M16.5 12.5H21V15h-4.5" />
      <path d="M6.5 9V7a4.5 4.5 0 0 1 9 0v2" />
    </svg>
  );
}

/** Small inline glyphs for the at-a-glance summary. */
function ShieldGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4.8 5.6v5.6c0 4.4 3 8.3 7.2 9.4 4.2-1.1 7.2-5 7.2-9.4V5.6L12 3Z" />
      <path d="m9.3 11.8 1.9 1.9 3.6-3.7" />
    </svg>
  );
}

function KeyGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.4" cy="8.4" r="4" />
      <path d="m11.3 11.3 8 8M17 17l-2 2M19.4 19.4l-2 2" />
    </svg>
  );
}

function QuestionGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.5" />
      <path d="M12 17h.01" />
    </svg>
  );
}

const QUESTION_PROMPTS = [
  'The name of the street you grew up on',
  'The name of your first pet',
  'The make of your first car',
  'The name of the school you attended',
  'The name of a city you have lived in',
  'The name of your favourite teacher',
  'The model of your first phone',
  'The name of a book that mattered to you',
];

const PASSKEY_REASON =
  'Passkeys need a server to register the credential against. This vault has no server, so a real passkey cannot be issued here.';

/** Modal wrapper used where a folder or vault gate is edited inside a dialog. */
export function SecurityFormModal({
  security,
  onChange,
  onNotify,
  label,
  onClose,
}: {
  security: LoginSecurity;
  onChange: (next: LoginSecurity) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
  label: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Security" onClose={onClose} wide footer={<button className="btn btn--primary" onClick={onClose}>Done</button>}>
      <SecurityForm security={security} onChange={onChange} onNotify={onNotify} label={label} />
    </Modal>
  );
}
