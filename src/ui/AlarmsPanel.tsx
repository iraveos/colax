import { useRef, useState } from 'react';
import { newAlarmId, type Alarm } from '../vault/storage.ts';
import { playAlarmSound } from './useAlarms.ts';
import { TrashIcon } from './icons.tsx';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The reminders list: add, toggle, test the sound, delete. Sounds import from the device. */
export function AlarmsPanel({
  alarms,
  onChange,
  onNotify,
}: {
  alarms: Alarm[];
  onChange: (next: Alarm[]) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [label, setLabel] = useState('');
  const [time, setTime] = useState('08:00');
  const [days, setDays] = useState<number[]>([]);
  const [sound, setSound] = useState<Alarm['sound']>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importSound(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      });
      if (dataUrl.length > 400_000) {
        onNotify('That sound file is too large; keep it under ~300 KB.', 'error');
        return;
      }
      setSound({ name: file.name, dataUrl });
      onNotify(`Sound "${file.name}" imported`);
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : 'Could not read that file.', 'error');
    }
  }

  function add() {
    const alarm: Alarm = {
      id: newAlarmId(),
      label: label.trim(),
      time,
      days,
      sound,
      enabled: true,
    };
    onChange([...alarms, alarm]);
    setLabel('');
    setDays([]);
    setSound(null);
    onNotify('Alarm added');
  }

  return (
    <div className="alarms">
      <p className="field__note">Alarms ring while the app is open. Pick a sound from your device or keep the built-in chime.</p>

      {alarms.length > 0 ? (
        <ul className="alarms__list">
          {alarms.map((alarm) => (
            <li key={alarm.id} className="alarms__row">
              <div className="alarms__main">
                <span className="alarms__time">{alarm.time}</span>
                <span className="alarms__label">{alarm.label || 'No label'}</span>
                <span className="alarms__days">
                  {alarm.days.length === 0 ? 'Every day' : alarm.days.map((day) => DAY_LABELS[day]).join(', ')}
                </span>
              </div>
              <button
                className="btn btn--quiet btn--sm"
                onClick={() => playAlarmSound(alarm)}
                aria-label={`Play the sound for ${alarm.label || alarm.time}`}
              >
                Test
              </button>
              <button
                className="btn btn--icon btn--sm"
                aria-label={alarm.enabled ? 'Disable alarm' : 'Enable alarm'}
                onClick={() =>
                  onChange(alarms.map((entry) => (entry.id === alarm.id ? { ...entry, enabled: !entry.enabled } : entry)))
                }
              >
                <span className={`alarms__dot ${alarm.enabled ? 'alarms__dot--on' : ''}`} aria-hidden="true" />
              </button>
              <button
                className="btn btn--icon btn--sm"
                aria-label={`Delete alarm ${alarm.label || alarm.time}`}
                onClick={() => onChange(alarms.filter((entry) => entry.id !== alarm.id))}
              >
                <TrashIcon width="13" height="13" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field__note">No alarms yet.</p>
      )}

      <div className="sec__card">
        <h3 className="sec__title">New alarm</h3>
        <div className="field">
          <label className="field__label" htmlFor="alarm-label">
            Label
          </label>
          <input id="alarm-label" className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Call mum" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="alarm-time">
            Time
          </label>
          <input id="alarm-time" className="input input--mono" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </div>
        <div className="field">
          <span className="field__label">Days</span>
          <div className="alarms__day-row">
            {DAY_LABELS.map((dayLabel, index) => {
              const on = days.includes(index);
              return (
                <button
                  key={dayLabel}
                  className="tag-chip"
                  aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((day) => day !== index) : [...days, index])}
                >
                  {dayLabel}
                </button>
              );
            })}
          </div>
        </div>
        <div className="field">
          <span className="field__label">Sound</span>
          <div className="field-row">
            <button type="button" className="btn btn--secondary" onClick={() => fileInput.current?.click()}>
              Import sound
            </button>
            {sound ? (
              <>
                <span className="chip chip--tag">{sound.name}</span>
                <button className="btn btn--ghost btn--sm" onClick={() => setSound(null)}>
                  Reset to chime
                </button>
              </>
            ) : (
              <span className="field__note">Built-in chime</span>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              className="sr-only"
              onChange={(event) => void importSound(event.target.files?.[0])}
            />
          </div>
        </div>
        <button className="btn btn--primary" onClick={add} disabled={!time}>
          Add alarm
        </button>
      </div>
    </div>
  );
}
