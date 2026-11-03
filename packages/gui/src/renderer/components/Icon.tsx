import "../styles/icons.css";

/**
 * The app's own line icons (R75). One 24-unit grid, a 1.7 stroke with round
 * ends and joins, drawn in the text colour and sized by font-size (1em), so an
 * icon sits exactly where a glyph sat (☰ ＋ ··· ↑ ■ ◷ ◎ ×) without changing
 * the button around it. Always decorative: the control keeps its own label.
 * `spark` is the brand mark — the app icon's star with drawn-in sides —
 * and the only filled shape.
 */
const SHAPES = {
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  send: <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none" />,
  attach: (
    <path d="m19.5 11.2-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  check: <path d="m5.5 12 4.5 4.5L19 7" />,
  /** An attached file that is not a picture (R78). */
  file: (
    <>
      <path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M13.5 3.5V8H18M9 12.5h6M9 16h4" />
    </>
  ),
  spark: (
    <path
      d="M12 2.5c.7 6 3.5 8.8 9.5 9.5-6 .7-8.8 3.5-9.5 9.5-.7-6-3.5-8.8-9.5-9.5 6-.7 8.8-3.5 9.5-9.5Z"
      fill="currentColor"
      stroke="none"
    />
  ),
} as const;

export type IconName = keyof typeof SHAPES;

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): JSX.Element {
  return (
    <svg
      className={className ? `herta-icon ${className}` : "herta-icon"}
      data-icon={name}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
