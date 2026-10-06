import { useEffect, useRef } from 'react';
import type { Alarm } from '../vault/storage.ts';

/** Checks alarms once a second and rings those whose minute has arrived. */
export function useAlarms(alarms: Alarm[], onRing: (alarm: Alarm) => void) {
  const lastFired = useRef(new Map<string, string>());
  // Keep the latest handler without restarting the interval.
  const handler = useRef(onRing);
  handler.current = onRing;

  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const day = now.getDay();
      const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${hh}:${mm}`;

      for (const alarm of alarms) {
        if (!alarm.enabled) continue;
        if (alarm.time !== `${hh}:${mm}`) continue;
        if (alarm.days.length > 0 && !alarm.days.includes(day)) continue;
        if (lastFired.current.get(alarm.id) === stamp) continue;
        lastFired.current.set(alarm.id, stamp);
        handler.current(alarm);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [alarms]);
}

/** The built-in default chime: three short sine tones. */
export function playDefaultChime(): void {
  try {
    const ctx = new AudioContext();
    const notes = [880, 660, 990];
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 1200);
  } catch {
    // Audio is best-effort.
  }
}

/** Plays an alarm's sound, falling back to the chime. */
export function playAlarmSound(alarm: Alarm): void {
  if (alarm.sound?.dataUrl) {
    try {
      const audio = new Audio(alarm.sound.dataUrl);
      void audio.play().catch(() => playDefaultChime());
      return;
    } catch {
      // Fall through to the chime.
    }
  }
  playDefaultChime();
}
