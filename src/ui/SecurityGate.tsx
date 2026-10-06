import { useState } from 'react';
import { Modal } from './primitives.tsx';
import { verifyAnswer, verifyPasscode, verifyTotp, type LoginSecurity } from '../crypto/security.ts';

/**
 * A blocking verification step for a login, a folder, or the whole vault.
 *
 * Any one factor passes: a valid authenticator code, a correct answer to one of
 * the stored questions, or the user's own passcode. Nothing is stored by this
 * component; it only asks and verifies.
 */
export function SecurityGate({
  security,
  title,
  hint,
  onVerified,
  onCancel,
}: {
  security: LoginSecurity;
  title: string;
  hint?: string;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const hasTotp = Boolean(security.totp?.seed);
  const hasPasscode = Boolean(security.passcode?.hash);
  const hasQuestions = security.questions.length > 0;

  // Prefer whichever factor the user actually set. The order matters: a
  // passcode is the fastest thing to type, so it leads when present.
  const [mode, setMode] = useState<'passcode' | 'totp' | 'question'>(
    hasPasscode ? 'passcode' : hasTotp ? 'totp' : 'question',
  );
  const [code, setCode] = useState('');
  const [passcode, setPasscode] = useState('');
  const [questionId, setQuestionId] = useState(security.questions[0]?.id ?? '');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function checkTotp() {
    if (!security.totp || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await verifyTotp(security.totp.seed, code);
      if (ok) onVerified();
      else setError('That code did not match. Try the current one.');
    } finally {
      setBusy(false);
    }
  }

  async function checkPasscode() {
    if (!security.passcode || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await verifyPasscode(security.passcode, passcode);
      if (ok) onVerified();
      else setError('That passcode does not match.');
    } finally {
      setBusy(false);
    }
  }

  async function checkAnswer() {
    const question = security.questions.find((entry) => entry.id === questionId);
    if (!question || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await verifyAnswer(question, answer);
      if (ok) onVerified();
      else setError('That answer does not match.');
    } finally {
      setBusy(false);
    }
  }

  const submit = () => {
    if (mode === 'totp') void checkTotp();
    else if (mode === 'passcode') void checkPasscode();
    else void checkAnswer();
  };

  const modeCount = [hasTotp, hasPasscode, hasQuestions].filter(Boolean).length;
  const canSubmit =
    mode === 'totp'
      ? code.replace(/\D/g, '').length === 6
      : mode === 'passcode'
        ? passcode.length > 0
        : answer.trim().length > 0;

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={submit}
            disabled={busy || !canSubmit}
          >
            {busy ? <span className="spinner" /> : null}
            Unlock
          </button>
        </>
      }
    >
      <p className="field__note" style={{ marginBottom: 'var(--space-4)' }}>
        {hint ?? 'This is protected. Prove it is you to continue.'}
      </p>

      {modeCount > 1 ? (
        <div className="segmented" style={{ marginBottom: 'var(--space-4)' }}>
          {hasPasscode ? (
            <button className="segmented__option" aria-pressed={mode === 'passcode'} onClick={() => setMode('passcode')}>
              Passcode
            </button>
          ) : null}
          {hasTotp ? (
            <button className="segmented__option" aria-pressed={mode === 'totp'} onClick={() => setMode('totp')}>
              Authenticator
            </button>
          ) : null}
          {hasQuestions ? (
            <button className="segmented__option" aria-pressed={mode === 'question'} onClick={() => setMode('question')}>
              Recovery question
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'passcode' && hasPasscode ? (
        <div className="field">
          <label className="field__label" htmlFor="gate-passcode">
            Passcode
          </label>
          <input
            id="gate-passcode"
            className="input"
            type="password"
            value={passcode}
            autoFocus
            autoComplete="off"
            placeholder="Your passcode"
            onChange={(event) => setPasscode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void checkPasscode();
              }
            }}
          />
        </div>
      ) : null}

      {mode === 'totp' && hasTotp ? (
        <div className="field">
          <label className="field__label" htmlFor="gate-code">
            6-digit code
          </label>
          <input
            id="gate-code"
            className="input input--mono"
            value={code}
            inputMode="numeric"
            autoFocus
            placeholder="000000"
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void checkTotp();
              }
            }}
          />
        </div>
      ) : null}

      {mode === 'question' && hasQuestions ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="gate-question">
              Question
            </label>
            <select
              id="gate-question"
              className="select__trigger"
              value={questionId}
              onChange={(event) => setQuestionId(event.target.value)}
            >
              {security.questions.map((question) => (
                <option key={question.id} value={question.id}>
                  {question.prompt}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="gate-answer">
              Answer
            </label>
            <input
              id="gate-answer"
              className="input"
              value={answer}
              autoFocus
              placeholder="Your answer"
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void checkAnswer();
                }
              }}
            />
          </div>
        </>
      ) : null}

      {error ? <p className="sec__error" role="alert">{error}</p> : null}
    </Modal>
  );
}
