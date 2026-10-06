import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/**
 * The house style, taken from the supplied Colax mark.
 *
 * The logo is bold, monochrome line-art with fully rounded caps and joins and
 * no hairline detail, so the set matches it in three deliberate ways: a heavier
 * stroke than the usual icon library default, round caps *and* joins on every
 * path, and geometry reduced to the fewest closed shapes that still read at
 * 16px. Weight comes from the stroke rather than filled outlines so every glyph
 * inherits `currentColor` and themes for free.
 */
const STROKE = 2.4;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/**
 * The logo mark itself, as inline SVG.
 *
 * Recreated from the supplied PNG: a C-shaped swirl holding a person's head and
 * shoulders beside a password card, in the same heavy rounded line-art. Drawn
 * inline rather than embedded as an image so it takes `currentColor` and stays
 * crisp at any size — the PNG is black line-art, which is invisible on a dark
 * topbar without inverting it, and inverting raster artwork also inverts its
 * antialiasing into a visible halo.
 */
export function ColaxMark({ size = 30, className = 'colax-mark' }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* The C swirl: a near-closed arc with a gap on the right. */}
      <path d="M50 20.5A19 19 0 1 0 50 43.5" />
      {/* Head. */}
      <circle cx="27" cy="24.5" r="4.6" />
      {/* Shoulders. */}
      <path d="M18.5 37.5c.7-4.3 4.2-6.6 8.5-6.6s7.8 2.3 8.5 6.6" />
      {/* Password card, tucked into the swirl's gap. */}
      <rect x="34" y="27" width="16" height="11" rx="3" />
      <path d="M38 32.5h1.5M43 32.5h3.5" />
    </svg>
  );
}

/**
 * The app icon in the topbar.
 *
 * Uses the inline SVG mark rather than the PNG so it follows the theme. The
 * raster file is still what ships as the favicon and the installed-extension
 * icon, where there is no theme to follow.
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    // Deliberately not `.brand`: that class still exists in the stylesheet as
    // the old sidebar brand block and carries its own padding.
    <span className="brand-mark__wrap">
      <ColaxMark size={size} />
    </span>
  );
}

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 4.8 5.6v5.6c0 4.4 3 8.3 7.2 9.4 4.2-1.1 7.2-5 7.2-9.4V5.6L12 3Z" />
    <path d="m9.3 11.8 1.9 1.9 3.6-3.7" />
  </Icon>
);

/** A key inside a shield: marks a login that has its own second factor. */
export const KeyShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 4.8 5.6v5.6c0 4.4 3 8.3 7.2 9.4 4.2-1.1 7.2-5 7.2-9.4V5.6L12 3Z" />
    <circle cx="10.6" cy="10.4" r="1.7" />
    <path d="m12 11.6 2.4 2.4M13.4 12.9l1.2-1.2" />
  </Icon>
);

export const FolderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 7.5a2.5 2.5 0 0 1 2.5-2.5h3.6l2 2.4h6.9a2.5 2.5 0 0 1 2.5 2.5v7.6a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5Z" />
  </Icon>
);

export const MailIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
  </Icon>
);

export const BellIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 10.5a6 6 0 1 1 12 0c0 4 1.6 5.3 1.6 5.3H4.4S6 14.5 6 10.5" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.6" />
    <path d="m16 16 4 4" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);

export const LockIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10" width="15" height="10.5" rx="3" />
    <path d="M8.2 10V7.6a3.8 3.8 0 0 1 7.6 0V10" />
  </Icon>
);

export const UnlockIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10" width="15" height="10.5" rx="3" />
    <path d="M8.2 10V7.6a3.8 3.8 0 0 1 7-1.6" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.4 6.1A8.6 8.6 0 0 1 12 5.9c6 0 9.2 6.1 9.2 6.1a17 17 0 0 1-3 3.7" />
    <path d="M6.4 7.3A17 17 0 0 0 2.8 12s3.2 6.1 9.2 6.1a8.3 8.3 0 0 0 3.8-.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11.5" height="11.5" rx="3" />
    <path d="M15 6.4V5.6A2.6 2.6 0 0 0 12.4 3H5.6A2.6 2.6 0 0 0 3 5.6v6.8A2.6 2.6 0 0 0 5.6 15h.8" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4.8 12.4 4.7 4.7L19.4 7.2" />
  </Icon>
);

export const DiceIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <circle cx="8.6" cy="8.6" r="1.35" fill="currentColor" stroke="none" />
    <circle cx="15.4" cy="15.4" r="1.35" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
    <circle cx="8.6" cy="15.4" r="1.35" fill="currentColor" stroke="none" />
    <circle cx="15.4" cy="8.6" r="1.35" fill="currentColor" stroke="none" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.2v2.2M12 18.6v2.2M4.5 7.5l1.9 1.1M17.6 15.4l1.9 1.1M3.2 12h2.2M18.6 12h2.2M4.5 16.5l1.9-1.1M17.6 8.6l1.9-1.1" />
  </Icon>
);

/**
 * A shield with a key inside it: "this login has a second factor".
 *
 * Used as the badge on a secured login, so the keyhole is read at 12px rather
 * than needing a separate glyph to cross-check against. The shield body is
 * filled and the key knocked out of it, which survives being scaled down far
 * better than two separate strokes would.
 */
export const SecuredIcon = (props: IconProps) => (
  <Icon fill="currentColor" strokeWidth={1.6} {...props}>
    <path d="M12 2.6 4.9 5.2v5.7c0 4.5 3 8.5 7.1 9.6 4.1-1.1 7.1-5.1 7.1-9.6V5.2L12 2.6Z" />
    {/* Knocked-out keyhole: a stem plus its bit, in the surface colour. */}
    <circle cx="12" cy="10.4" r="2.5" fill="var(--badge-knockout, #fff)" stroke="none" />
    <path
      d="M12 12.4v4.2m0-1.5h2.4"
      stroke="var(--badge-knockout, #fff)"
      strokeWidth={2.2}
      fill="none"
    />
  </Icon>
);

export const StarIcon = ({ filled, ...props }: IconProps & { filled?: boolean }) => (
  <Icon fill={filled ? 'currentColor' : 'none'} {...props}>
    <path d="m12 4.2 2.4 5 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10l5.4-.8 2.4-5Z" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 7h15M9.5 7V5.4A1.9 1.9 0 0 1 11.4 3.5h1.2a1.9 1.9 0 0 1 1.9 1.9V7" />
    <path d="M6.5 7v11.6A2.4 2.4 0 0 0 8.9 21h6.2a2.4 2.4 0 0 0 2.4-2.4V7" />
    <path d="M10.3 11v6M13.7 11v6" />
  </Icon>
);

export const EditIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12.5 20.5H20" />
    <path d="M16.8 3.9a2.4 2.4 0 0 1 3.3 3.3L7.6 19.7 3.5 20.5l.8-4.1L16.8 3.9Z" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.5 3.5H20.5V9.5" />
    <path d="m10.5 13.5 10-10" />
    <path d="M20.5 14.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h4.5" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.6v2.1M12 19.3v2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M2.6 12h2.1M19.3 12h2.1M5.4 18.6l1.5-1.5M17.1 6.9l1.5-1.5" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20.5 13.3A8.6 8.6 0 1 1 10.7 3.5a6.8 6.8 0 0 0 9.8 9.8Z" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.6v5.2M12 16.3v.1" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5v11.5M7.6 10.6 12 15l4.4-4.4" />
    <path d="M4 16.5v2.4a2.1 2.1 0 0 0 2.1 2.1h11.8a2.1 2.1 0 0 0 2.1-2.1v-2.4" />
  </Icon>
);

export const UploadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 15.5V4M7.6 8.4 12 4l4.4 4.4" />
    <path d="M4 16.5v2.4a2.1 2.1 0 0 0 2.1 2.1h11.8a2.1 2.1 0 0 0 2.1-2.1v-2.4" />
  </Icon>
);

export const FlagIcon = ({ filled, ...props }: IconProps & { filled?: boolean }) => (
  <Icon fill={filled ? 'currentColor' : 'none'} {...props}>
    <path d="M5.5 21.5V3.5" />
    <path d="M5.5 4.5h11l-1.5 3.6 1.5 3.6h-11" />
  </Icon>
);

export const TagIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 12.6V6a2.5 2.5 0 0 1 2.5-2.5h6.6l8 8-8 8-9.1-6.9Z" />
    <circle cx="8" cy="8" r="1.5" />
  </Icon>
);

export const CalendarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5.5" width="17" height="15" rx="3" />
    <path d="M3.5 10.5h17M8.5 3v4.5M15.5 3v4.5" />
  </Icon>
);

export const SidebarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M10 4.5v15" />
  </Icon>
);

export const KeyIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="4.4" />
    <path d="m11.3 11.3 8.2 8.2M17.4 17.4l2.1-2.1M14.6 14.6l2.1-2.1" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 6.8V12l3.4 2" />
  </Icon>
);

export const InboxIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 13.5h4.8l1.4 2.8h4.6l1.4-2.8h4.8" />
    <path d="M6.2 4.8h11.6l2.7 8.7v4.2a2.3 2.3 0 0 1-2.3 2.3H5.8a2.3 2.3 0 0 1-2.3-2.3v-4.2L6.2 4.8Z" />
  </Icon>
);

export const XIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const KeyboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2.6" />
    <path d="M6.2 10.4h.01M10 10.4h.01M13.8 10.4h.01M17.6 10.4h.01M8.4 14h7.2" />
  </Icon>
);

export const PaletteIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.4a8.6 8.6 0 1 0 0 17.2c1.2 0 2.1-1 2.1-2.1 0-.5-.2-1-.6-1.4-.3-.3-.5-.7-.5-1.1 0-.9.7-1.6 1.6-1.6h1.2a4.7 4.7 0 0 0 4.7-4.7c0-3.5-3.8-6.3-8.5-6.3Z" />
    <circle cx="7.6" cy="10.6" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.7" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="16.4" cy="10.6" r="1.15" fill="currentColor" stroke="none" />
  </Icon>
);

export const CloudIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M17.3 19.2a4.6 4.6 0 0 0 .6-9.2 6.1 6.1 0 0 0-11.8-1.4 4.3 4.3 0 0 0-.4 10.6h11.6Z" />
  </Icon>
);

export const LayersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3.4 8.5 4.6L12 12.6 3.5 8 12 3.4Z" />
    <path d="m3.5 13 8.5 4.6 8.5-4.6" />
  </Icon>
);

export const GridIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2.4" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2.4" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2.4" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2.4" />
  </Icon>
);

export const RowsIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5" width="17" height="5" rx="2.4" />
    <rect x="3.5" y="14" width="17" height="5" rx="2.4" />
  </Icon>
);

export const OrbitIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <ellipse cx="12" cy="12" rx="9.6" ry="4.2" />
    <ellipse cx="12" cy="12" rx="9.6" ry="4.2" transform="rotate(60 12 12)" />
  </Icon>
);

export const DatabaseIcon = (props: IconProps) => (
  <Icon {...props}>
    <ellipse cx="12" cy="5.8" rx="7.6" ry="2.9" />
    <path d="M4.4 5.8v5.7c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9V5.8" />
    <path d="M4.4 11.5v5.7c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9v-5.7" />
  </Icon>
);

export const ImageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="8.6" cy="9.6" r="1.7" />
    <path d="m4.5 17 4-4a2.4 2.4 0 0 1 3.4 0l3 3" />
    <path d="m13.8 14.8 1.8-1.8a2.4 2.4 0 0 1 3.4 0l1.5 1.5" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11.2v5M12 7.9v.1" />
  </Icon>
);

export const WrenchIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.6 6.6a4.2 4.2 0 0 0 5.4 5.4L21.4 13l-8.4 8.4-3.4-3.4L18 9.6l-3.4-3Z" />
    <path d="m6.6 3.6 2.8 2.8-2 2-2.8-2.8" />
  </Icon>
);

/* ---- Aliases used where the old shield glyph stood --------------------- */

/** Where "this login is sound" is meant. The shield, in the house style. */
export const IntegrityIcon = ShieldIcon;