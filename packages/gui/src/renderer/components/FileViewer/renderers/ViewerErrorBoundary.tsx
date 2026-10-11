import { Component, type ReactNode } from "react";

/**
 * A renderer that throws — at chunk load or mid-render — falls to the
 * panel's honest notice (ADR 0054 §3), never a blank body and never the
 * raw bytes. Keyed by the caller on the file so a new file gets a fresh
 * try.
 */
export class ViewerErrorBoundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
