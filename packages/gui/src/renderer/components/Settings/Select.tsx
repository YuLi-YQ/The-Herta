import { useEffect, useId, useRef, useState } from "react";
import { usePresence } from "../../hooks/usePresence.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";

export interface SelectOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SelectProps<V extends string> {
  readonly value: V;
  readonly options: readonly SelectOption<V>[];
  readonly onChange: (value: V) => void;
  readonly ariaLabel: string;
}

/** Chevron for the trigger — inline SVG so CSS owns color/size. */
function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="settings-select__chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Check mark on the selected option. */
function CheckIcon(): JSX.Element {
  return (
    <svg
      className="settings-select__check"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

/**
 * Custom dropdown for the Settings panes (user 2026-07-12: the native
 * `<select>` popup is OS chrome — it ignores the app's design language
 * entirely). A styled trigger opens a presence-animated popover menu:
 * options highlight on hover, the selected one carries a check, and the
 * menu closes on pick / Escape / outside click. Keyboard: the trigger is a
 * real button (Enter/Space toggles); ArrowUp/Down walk the options.
 */
export function Select<V extends string>(props: SelectProps<V>): JSX.Element {
  const [open, setOpen] = useState(false);
  const menu = usePresence(open, 160);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // While the popover is open, own the topmost-overlay slot ABOVE the
  // settings/key-prompt backdrop (cardMenu level). Without this, a single
  // Escape reached BOTH this menu's listener AND the SettingsModal's, so it
  // closed the dropdown AND the whole modal at once; now the modal's Escape
  // handler sees `!isTop` and defers, leaving Escape to close only the
  // dropdown (adversarial review 2026-07-15). useId keeps concurrent Selects
  // distinct in the stack.
  const overlayId = useId();
  useModalOverlay(overlayId, open, OVERLAY_Z.cardMenu);

  // Outside click / Escape close. Listener only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      if (rootRef.current?.contains(e.target) !== true) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, { capture: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, { capture: true });
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = props.options.find((o) => o.value === props.value);

  const moveFocus = (delta: number): void => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        ".settings-select__option",
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      idx === -1
        ? delta > 0
          ? 0
          : buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, idx + delta));
    // focus-scrolls: arrow-key navigation — the option must come into view.
    buttons[next]?.focus();
  };

  return (
    <div className="settings-select-wrap" ref={rootRef}>
      <button
        type="button"
        className={`settings-select-trigger${open ? " is-open" : ""}`}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && open) {
            e.preventDefault();
            moveFocus(1);
          }
        }}
      >
        <span className="settings-select__value">{selected?.label}</span>
        <ChevronIcon />
      </button>
      {menu.mounted && (
        <div
          ref={listRef}
          className={`settings-select-menu${menu.open ? " is-open" : ""}`}
          role="listbox"
          aria-label={props.ariaLabel}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              moveFocus(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {props.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === props.value}
              className={`settings-select__option${
                o.value === props.value ? " is-selected" : ""
              }`}
              onClick={() => {
                setOpen(false);
                if (o.value !== props.value) props.onChange(o.value);
              }}
            >
              <span className="settings-select__option-label">{o.label}</span>
              {o.value === props.value && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
