import type { KeyboardEvent } from "react";

/**
 * Escape closes a <details> drawn as a floating popover and puts focus back on
 * its summary, like the other small popovers (R63). IME composition keeps it
 * open, and the key stops here so an outer Escape handler (the round reader)
 * does not also close.
 */
export function closeDetailsOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  const details = event.currentTarget;
  if (
    event.key !== "Escape" ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229 ||
    !details.open
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  details.open = false;
  details.querySelector("summary")?.focus({ preventScroll: true });
}
