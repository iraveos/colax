import { useState } from 'react';
import type { VaultPreferences } from '../vault/storage.ts';
import { fetchGmailOnce } from './useGmail.ts';
import { Toggle } from './primitives.tsx';

const REFRESH_CHOICES = [2, 5, 10, 15, 30, 60];

/** The Gmail sign-in: an address plus an app password, and how often to re-read the inbox. */
export function IntegrationsPanel({
  gmail,
  onChange,
  onNotify,
}: {
  gmail: VaultPreferences['gmail'];
  onChange: (next: VaultPreferences['gmail']) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ count: number; error: string | null } | null>(null);

  async function test() {
    setTesting(true);
    setResult(null);
    let failed: string | null = null;
    try {
      const messages = await fetchGmailOnce(gmail.address, gmail.appPassword, undefined, (message) => {
        failed = message;
      });
      setResult({ count: messages.length, error: failed ?? (messages.length === 0 ? 'Connected, but no messages were returned.' : null) });
      if (!failed) onNotify(`Connected: ${messages.length} recent message${messages.length === 1 ? '' : 's'}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="integrations">
      <Row label="Connected" hint="Read your inbox inside the dashboard.">
        <Toggle label="Connected" checked={gmail.enabled} onChange={(enabled) => onChange({ ...gmail, enabled })} />
      </Row>
      <Row label="Gmail address" hint="The account whose inbox you want to see.">
        <input
          className="input"
          value={gmail.address}
          onChange={(event) => onChange({ ...gmail, address: event.target.value })}
          placeholder="you@gmail.com"
          inputMode="email"
          spellCheck={false}
        />
      </Row>
      <Row label="App password" hint="From Google Account > Security > App passwords. A different one than your normal password.">
        <input
          className="input"
          type="password"
          value={gmail.appPassword}
          onChange={(event) => onChange({ ...gmail, appPassword: event.target.value })}
          placeholder="16-character app password"
          autoComplete="off"
        />
      </Row>
      <Row label="Refresh every" hint="How often the inbox view re-checks for new mail while the door is open.">
        <div className="segmented segmented--wrap">
          {REFRESH_CHOICES.map((seconds) => (
            <button
              key={seconds}
              className="segmented__option"
              aria-pressed={gmail.refreshSeconds === seconds}
              onClick={() => onChange({ ...gmail, refreshSeconds: seconds })}
            >
              {seconds}s
            </button>
          ))}
        </div>
      </Row>
      <Row label="Check connection" hint="Fetches the inbox once, now.">
        <button className="btn btn--secondary" onClick={() => void test()} disabled={testing || !gmail.address || !gmail.appPassword}>
          {testing ? <span className="spinner" /> : null}
          Test
        </button>
      </Row>
      {result ? (
        <p className={result.error ? 'sec__error' : 'field__note'}>
          {result.error ?? `Connected. ${result.count} recent message${result.count === 1 ? '' : 's'} found.`}
        </p>
      ) : null}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <p className="field__note" style={{ marginTop: 0 }}>{hint}</p>
      {children}
    </div>
  );
}
