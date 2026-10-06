import { useCallback } from 'react';
import type { CardSizePrefs, VaultView } from '../vault/storage.ts';
import { DEFAULT_CARD_SIZE } from '../vault/storage.ts';
import { CHANNEL_ACCENTS, type ChannelAccent } from '../vault/channels.ts';

/** Same hues the channel editor uses, so the two pickers agree. */
const ACCENT_HUES: Record<string, number> = { slate: 212, sage: 152, dusk: 268, clay: 28 };

function accentGradient(accent: string): string {
  const hue = ACCENT_HUES[accent] ?? 212;
  return `linear-gradient(135deg, hsl(${hue} 44% 58%), hsl(${(hue + 22) % 360} 38% 46%))`;
}

/**
 * The appearance panel.
 *
 * A slide-over rather than a modal, and deliberately translucent: the whole
 * point is to change card size and colour *while watching the cards change*.
 * A centred modal with an opaque backdrop would hide the very thing being
 * tuned, so the user would be dragging a slider blind and then have to close
 * the panel to find out whether they liked it. The panel sits over the right
 * edge, leaves the list visible down its left side, and writes every change
 * straight through to preferences so the effect is immediate and undoable by
 * moving the slider back.
 */

const VIEW_LABELS: Record<VaultView, string> = {
  animated: 'Flow',
  carousel: 'Orbit',
  basic: 'List',
};

/** One slider, with its live value shown the way the user set it. */
function Slider({
  id,
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="field">
      <div className="field-row" style={{ justifyContent: 'space-between' }}>
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <output className="slider-row__value" htmlFor={id}>
          {Math.round(value * 100) / 100}
          {suffix}
        </output>
      </div>
      <input
        id={id}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

export function AppearancePanel({
  view,
  cardSize,
  accent,
  onCardSizeChange,
  onAccentChange,
  onClose,
}: {
  view: VaultView;
  cardSize: CardSizePrefs;
  accent: ChannelAccent;
  onCardSizeChange: (next: CardSizePrefs) => void;
  onAccentChange: (next: ChannelAccent) => void;
  onClose: () => void;
}) {
  const set = useCallback(
    (patch: Partial<CardSizePrefs>) => onCardSizeChange({ ...cardSize, ...patch }),
    [cardSize, onCardSizeChange],
  );

  const isOrbit = view === 'carousel';
  const isList = view === 'basic';

  return (
    <aside className="tuner" role="dialog" aria-label="Card appearance" aria-modal="false">
      <header className="tuner__head">
        <div>
          <h2 className="tuner__title">Card appearance</h2>
          <p className="tuner__hint">
            Changes apply as you drag. Tuned per view, so {VIEW_LABELS[view]} keeps its own settings.
          </p>
        </div>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close appearance panel">
          <CloseIcon />
        </button>
      </header>

      <div className="tuner__body">
        <section className="tuner__group">
          <h3 className="tuner__legend">Size</h3>

          <Slider
            id="tuner-scale"
            label="Scale"
            hint="Scales the whole card, text included."
            value={cardSize.scale}
            min={0.6}
            max={1.6}
            step={0.05}
            suffix="×"
            onChange={(scale) => set({ scale })}
          />

          <Slider
            id="tuner-width"
            label={isList ? 'Maximum width' : 'Width'}
            hint={
              isList
                ? 'The measure of the list. Text gets harder to read past about 100 characters.'
                : isOrbit
                  ? 'How much of the ring is visible. Wider cards mean fewer in view at once.'
                  : 'How wide each card is allowed to grow.'
            }
            value={cardSize.width}
            min={isOrbit ? 220 : 280}
            max={isOrbit ? 520 : 1200}
            step={10}
            suffix="px"
            onChange={(width) => set({ width })}
          />

          {isOrbit ? (
            <Slider
              id="tuner-aspect"
              label="Height"
              hint="A multiple of the width. Taller suits a photo, squarer suits a title."
              value={cardSize.aspect}
              min={0.6}
              max={2.2}
              step={0.05}
              suffix="×"
              onChange={(aspect) => set({ aspect })}
            />
          ) : (
            <Slider
              id="tuner-min-height"
              label="Minimum height"
              hint="A floor, not a cap: a card with a photo or a long title still grows past it."
              value={cardSize.minHeight}
              min={isList ? 40 : 60}
              max={isList ? 220 : 400}
              step={4}
              suffix="px"
              onChange={(minHeight) => set({ minHeight })}
            />
          )}

          <Slider
            id="tuner-radius"
            label="Corner radius"
            value={cardSize.radius}
            min={0}
            max={48}
            step={1}
            suffix="px"
            onChange={(radius) => set({ radius })}
          />

          <Slider
            id="tuner-surface"
            label="Card surface"
            hint="0 lets the background show straight through the card."
            value={cardSize.surface}
            min={0}
            max={1}
            step={0.05}
            onChange={(surface) => set({ surface })}
          />
        </section>

        <section className="tuner__group">
          <h3 className="tuner__legend">Accent</h3>
          <div className="accent-grid">
            {CHANNEL_ACCENTS.map((option) => (
              <button
                type="button"
                key={option}
                className="accent-swatch"
                aria-pressed={accent === option}
                onClick={() => onAccentChange(option)}
              >
                <span
                  className="accent-swatch__chip"
                  aria-hidden="true"
                  style={{ background: accentGradient(option) }}
                />
                <span className="option-card__label">{option[0]?.toUpperCase()}{option.slice(1)}</span>
              </button>
            ))}
          </div>
          <p className="field__hint">Applies to the whole app while this view is open.</p>
        </section>

        <button
          type="button"
          className="btn btn--secondary tuner__reset"
          onClick={() => onCardSizeChange({ ...DEFAULT_CARD_SIZE[view] })}
        >
          Reset {VIEW_LABELS[view]} to defaults
        </button>
      </div>
    </aside>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}