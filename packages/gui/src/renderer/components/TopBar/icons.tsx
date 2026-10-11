/**
 * Inline outline icons for the TopBar controls.
 *
 * Rendered inline (NOT via `<img>`) so CSS can drive `stroke-width` and
 * `color` on hover / focus / active — a raster PNG or an SVG loaded through
 * `<img>` is opaque to CSS and can't be re-stroked. See
 * `.sidebar-header-icon-svg` in `reference-ux.css` for the rest→hover
 * transition (light grey → deepened dark, 1.5 → 2 stroke).
 *
 * Paths are the Heroicons-style outline glyphs from
 * `reference_UX_design/icons/*_outline.svg`. Stroke width is intentionally
 * NOT set as an attribute here — CSS owns it so hover can change it.
 */

function IconSvg(props: {
  readonly dataIcon: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <svg
      className="sidebar-header-icon-svg"
      data-icon={props.dataIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export function PanelToggleIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="panel-toggle">
      <path d="M9 4.5v15m-4.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
    </IconSvg>
  );
}

export function SearchIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="search">
      <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </IconSvg>
  );
}

export function NewSessionIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="new-session">
      <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </IconSvg>
  );
}
