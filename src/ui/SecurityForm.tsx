import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  answerTooWeak,
  currentTotpCode,
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
import { Modal } from './primitives.tsx';

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
  const [liveCode, setLiveCode] = useState('');
  const [qr, setQr] = useState('');

  // The live code, re-read once a second. Cheap, and it proves the seed works
  // before the user scans it into their phone.
  useEffect(() => {
    if (!security.totp?.seed) {
      setLiveCode('');
      setQr('');
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const code = await currentTotpCode(security.totp!.seed);
        if (!cancelled) setLiveCode(code);
      } catch {
        if (!cancelled) setLiveCode('');
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [security.totp?.seed]);

  useEffect(() => {
    if (!security.totp?.seed) return;
    let cancelled = false;
    void QRCode.toDataURL(otpauthUrl(security.totp.seed, label), { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQr(url);
    }).catch(() => {
      if (!cancelled) setQr('');
    });
    return () => {
      cancelled = true;
    };
  }, [security.totp?.seed, label]);

  async function attachSeed() {
    const seed = extractTotpSeed(seedInput);
    if (!seed) {
      onNotify('That does not look like an authenticator key', 'error');
      return;
    }
    onChange({ ...security, totp: { seed } });
    setSeedInput('');
    onNotify('Authenticator key saved');
  }

  async function generate() {
    const seed = generateTotpSeed();
    onChange({ ...security, totp: { seed } });
    onNotify('New authenticator key created');
  }

  async function confirmCode() {
    if (!security.totp?.seed) return;
    const ok = await verifyTotp(security.totp.seed, codeInput);
    if (!ok) {
      setCodeError('That code did not match. Check the clock on this device.');
      return;
    }
    setCodeError('');
    onNotify('Authenticator confirmed');
  }

  function detach() {
    onChange({ ...security, totp: null });
    setCodeInput('');
    setQr('');
    onNotify('Authenticator removed');
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

  return (
    <div className="sec">
      <div className="sec__intro">
        <p className="sec__lead">
          Optional. With nothing here, this works exactly as before. With something here, it gates access.
        </p>
        <span className="sec__state" data-level={level}>
          {level === 'none' ? 'No second factor' : level === 'partial' ? 'Partly protected' : 'Protected'}
        </span>
      </div>

      <section className="sec__card">
        <header className="sec__head">
          <h3 className="sec__title">Authenticator app</h3>
          {security.totp ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={detach}>
              Remove
            </button>
          ) : null}
        </header>

        {security.totp ? (
          <>
            {qr ? (
              <div className="sec__qr">
                <img src={qr} alt="Scan this QR code with your authenticator app" width={220} height={220} />
                <p className="field__note">Scan this with your authenticator app, then confirm a code below.</p>
              </div>
            ) : null}
            <dl className="sec__facts">
              {liveCode ? (
                <>
                  <dt>Code now</dt>
                  <dd className="sec__code">{liveCode}</dd>
                </>
              ) : null}
            </dl>
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

      <section className="sec__card">
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

      <section className="sec__card">
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
            <select
              className="select__trigger"
              value={newPrompt}
              onChange={(event) => setNewPrompt(event.target.value)}
              aria-label="Question"
            >
              {QUESTION_PROMPTS.map((prompt) => (
                <option key={prompt} value={prompt}>
                  {prompt}
                </option>
              ))}
            </select>
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

      <section className="sec__card" data-disabled>
        <header className="sec__head">
          <h3 className="sec__title">Passkey</h3>
          <span className="sec__badge">Not available here</span>
        </header>
        <p className="field__note">{PASSKEY_REASON}</p>
      </section>
    </div>
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
