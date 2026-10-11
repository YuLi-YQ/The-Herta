import { createContext, type ReactNode, useContext } from "react";

/**
 * Lets deep row content tell the Conversation scroller that the reader has
 * chosen to read IN PLACE — expanding a collapsed diff or an activity
 * history grows the content by hundreds/thousands of px below the toggle,
 * but `pinnedRef` only recomputes on SCROLL events, so the scroller still
 * believes the reader is "following the bottom". The next follow trigger
 * (a window resize, the next streamed block, a status row) then yanked the
 * viewport to the conversation's end, past the just-expanded content — the
 * "expands upward" read (user 2026-07-14). Expanding = reading intent →
 * unpin; the pin re-arms the moment the reader is back at the bottom — by
 * scrolling there, or by the disclosure collapsing under them (the
 * scroller's `rederivePin`, 2026-09-02) — or sends a message, which re-pins
 * explicitly. A reader already scrolled away is left exactly as they are:
 * the unpin is a no-op there, so the chip keeps lighting for growth below.
 */
const Ctx = createContext<(() => void) | null>(null);

export function ConversationPinProvider(props: {
  readonly unpin: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return <Ctx.Provider value={props.unpin}>{props.children}</Ctx.Provider>;
}

const NOOP = (): void => {};

/** The unpin action, or a no-op outside a Conversation (tests, previews). */
export function useUnpinConversation(): () => void {
  return useContext(Ctx) ?? NOOP;
}
