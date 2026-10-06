import { useEffect, useRef, useState, type FormEvent } from 'react';
import { estimateStrength, suggestMasterPassword } from '../crypto/passwords.ts';
import { Alert, StrengthMeter } from './primitives.tsx';
import { AlertIcon, LockIcon, MoonIcon, ShieldIcon, SunIcon, UnlockIcon } from './icons.tsx';
import type { Toast } from './hooks.ts';

type Stage = 'choose' | 'password' | 'confirm' | 'opening';

export function LockScreen({
  mode,
  protection,
  onUnlock,
  onCreate,
  onToggleTheme,
  theme,
  persistent,
  onNotify,
}: {
  mode: 'unlock' | 'create';
  protection: 'password' | 'device' | null;
  onUnlock: (password?: string) => Promise<boolean>;
  onCreate: (password?: string) => Promise<void>;
  onToggleTheme: () => void;
  theme: 'light' | 'dark';
  persistent: boolean;
  onNotify: (message: string, tone?: Toast['tone']) => void;
}) {
  const [stage, setStage] = useState<Stage>(() => {
    if (mode === 'create') return 'choose';
    return protection === 'password' ? 'password' : 'opening';
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setStage(mode === 'create' ? 'choose' : protection === 'password' ? 'password' : 'opening');
    setPassword('');
    setConfirm('');
    setError(null);
    input.current?.focus();
  }, [mode, protection]);

  const strength = estimateStrength(password);

  async function openVault(next?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(next);
      if (!ok) {
        setError('That vault password is not correct.');
        setPassword('');
        input.current?.focus();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the vault.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (stage === 'opening') return openVault();
    if (stage === 'password' && mode === 'unlock') return openVault(password);

    if (stage === 'choose') return setStage('password');
    if (stage === 'password') {
      if (strength.score < 2) {
        setError('Choose a longer vault password, or use the suggestion.');
        return;
      }
      return setStage('confirm');
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await onCreate(password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the vault.');
      setBusy(false);
      setStage('password');
    }
  }

  function useSuggested() {
    const suggestion = suggestMasterPassword();
    setPassword(suggestion);
    setConfirm(suggestion);
    setStage('confirm');
    setError(null);
    onNotify('Suggested vault password set — save it somewhere safe now');
  }

  /* ---- Passwordless vault: one tap, no typing ------------------------- */
  if (stage === 'opening' && mode === 'unlock') {
    return (
      <Frame
        title="Welcome back"
        hint="This vault has no password, so it opens straight away."
        theme={theme}
        onToggleTheme={onToggleTheme}
        persistent={persistent}
      >
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <button className="btn btn--primary btn--lg btn--block" onClick={() => void openVault()} disabled={busy}>
          {busy ? <span className="spinner" /> : <UnlockIcon />}
          Open vault
        </button>
        <p className="field__note" style={{ marginTop: 'var(--space-5)', textAlign: 'center' }}>
          Anyone with access to this browser profile can open the vault. You can add a vault password in
          Settings.
        </p>
      </Frame>
    );
  }

  /* ---- New vault: choose protection first ----------------------------- */
  if (stage === 'choose') {
    return (
      <Frame
        title="Set up your vault"
        hint="Pick how this vault protects itself. You can change this later in Settings."
        theme={theme}
        onToggleTheme={onToggleTheme}
        persistent={persistent}
      >
        <button className="btn btn--primary btn--lg btn--block" onClick={() => void onCreate()}>
          <UnlockIcon />
          Continue without a password
        </button>
        <button
          className="btn btn--secondary btn--lg btn--block"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={() => setStage('password')}
        >
          <LockIcon />
          Add a vault password
        </button>
        <p className="field__note" style={{ marginTop: 'var(--space-5)' }}>
          No password means the vault opens instantly on this device, and anyone who can read this browser's
          data can open it too. A vault password encrypts the key itself, so your logins stay unreadable
          without it.
        </p>
      </Frame>
    );
  }

  const isUnlock = mode === 'unlock';
  const titles = {
    password: isUnlock ? 'Welcome back' : 'Add a vault password',
    confirm: 'Confirm your vault password',
    opening: 'Welcome back',
    choose: 'Set up your vault',
  } as const;

  return (
    <Frame
      title={titles[stage]}
      hint={
        isUnlock
          ? 'Enter your vault password to decrypt it.'
          : 'This password encrypts the vault key. It is never stored or sent anywhere, and there is no way to recover it.'
      }
      theme={theme}
      onToggleTheme={onToggleTheme}
      persistent={persistent}
    >
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}

      <form onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor="master">
            Vault password
          </label>
          <div className="field-row">
            <input
              id="master"
              ref={input}
              className="input"
              type="password"
              autoComplete={isUnlock ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isUnlock ? 'Your vault password' : 'Something long and memorable'}
              disabled={busy}
            />
          </div>
        </div>

        {stage === 'confirm' ? (
          <div className="field">
            <label className="field__label" htmlFor="confirm">
              Repeat vault password
            </label>
            <input
              id="confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={busy}
            />
          </div>
        ) : null}

        {!isUnlock ? (
          <div className="field">
            <StrengthMeter password={password} />
          </div>
        ) : null}

        <button
          type="submit"
          className="btn btn--primary btn--lg btn--block"
          disabled={busy || (stage !== 'confirm' ? !password : !confirm)}
        >
          {busy ? <span className="spinner" /> : <LockIcon />}
          {stage === 'confirm' ? 'Create vault' : 'Continue'}
        </button>
      </form>

      {!isUnlock && stage === 'password' ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <button type="button" className="btn btn--ghost btn--block" onClick={useSuggested}>
            Suggest a strong vault password
          </button>
        </div>
      ) : null}

      {!isUnlock ? (
        <button
          type="button"
          className="btn btn--ghost btn--block"
          style={{ marginTop: 'var(--space-2)' }}
          onClick={() => {
            setStage('choose');
            setPassword('');
            setError(null);
          }}
        >
          Back
        </button>
      ) : null}
    </Frame>
  );
}

function Frame({
  title,
  hint,
  theme,
  onToggleTheme,
  persistent,
  children,
}: {
  title: string;
  hint: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  persistent: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="lock">
      <div className="lock__card">
        <div className="lock__brand">
          <div className="lock__mark">
            <ShieldIcon width="28" height="28" />
          </div>
          <div>
            <h1 className="lock__title">{title}</h1>
            <p className="lock__hint">{hint}</p>
          </div>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            style={{ position: 'absolute', top: 'var(--space-5)', right: 'var(--space-5)' }}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>

        {!persistent ? (
          <Alert tone="warn">
            Browser storage is blocked, so this vault will be lost when you close the tab. Private or restricted
            windows sometimes cause this.
          </Alert>
        ) : null}

        {children}
      </div>
    </div>
  );
}

function ErrorAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert tone="danger">
      <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertIcon width="16" height="16" style={{ marginTop: 2, flexShrink: 0 }} />
        {children}
      </span>
    </Alert>
  );
}