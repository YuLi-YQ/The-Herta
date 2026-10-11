export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** Accessible name for the switch (the row title isn't programmatically tied). */
  readonly ariaLabel: string;
  /** The setting cannot apply here at all — e.g. real-time voice with no
   *  model installed (ADR 0042). Dimmed and inert, with the row's note
   *  saying why: a switch that flips and changes nothing is worse than one
   *  that plainly cannot. */
  readonly disabled?: boolean;
}

/**
 * iOS-style switch. A `<button role="switch">` so Space/Enter activate it
 * natively; the knob slides and the track tints via `aria-checked` in CSS.
 * Reusable across Settings sections.
 */
export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`settings-toggle${disabled ? " is-disabled" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" aria-hidden="true" />
    </button>
  );
}
