/**
 * Sun / moon theme switch.
 *
 * The knob slides across a track and rotates as it goes, with clouds drifting
 * behind it in daylight and stars fading in for night. Built from the CSS the
 * design calls for, converted to a real <button> with role="switch" rather than
 * a hidden checkbox driven by an id, which does not survive React rendering.
 */

export function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: 'light' | 'dark';
  onToggle: () => void;
}) {
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="theme-switch"
      role="switch"
      aria-checked={isDark}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <span className="theme-switch__track" data-on={isDark || undefined}>
        <svg className="theme-switch__sky" viewBox="0 0 60 34" aria-hidden="true">
          {/* Light rays, only meaningful in the day state. */}
          <g className="theme-switch__rays" fill="#fff">
            <rect x="-4" y="-4" width="43" height="43" rx="6" opacity="0.1" transform="rotate(20 17 17)" />
            <rect x="-14" y="-14" width="55" height="55" rx="8" opacity="0.08" transform="rotate(20 17 17)" />
          </g>

          <g className="theme-switch__clouds">
            <ellipse className="theme-switch__cloud" cx="34" cy="20" rx="13" ry="5" fill="currentColor" opacity="0.55" />
            <ellipse className="theme-switch__cloud" cx="44" cy="17" rx="7" ry="3.4" fill="currentColor" opacity="0.5" />
            <ellipse className="theme-switch__cloud" cx="25" cy="23" rx="9" ry="4" fill="currentColor" opacity="0.45" />
          </g>

          <g className="theme-switch__stars" fill="#fff">
            <circle className="theme-switch__star" cx="9" cy="7" r="1.6" style={{ animationDelay: '0.3s' }} />
            <circle className="theme-switch__star" cx="20" cy="4" r="1" style={{ animationDelay: '1.3s' }} />
            <circle className="theme-switch__star" cx="14" cy="14" r="1.3" style={{ animationDelay: '0.6s' }} />
          </g>
        </svg>

        <span className="theme-switch__knob" data-on={isDark || undefined}>
          <svg className="theme-switch__sun" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="5" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 1.5v2.4M12 20.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M1.5 12h2.4M20.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
            </g>
          </svg>
          <svg className="theme-switch__moon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z" fill="currentColor" />
          </svg>
        </span>
      </span>
    </button>
  );
}