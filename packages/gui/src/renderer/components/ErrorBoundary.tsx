import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Rendered instead of the children after a render-phase throw. A
   *  function form receives the error (e.g. to show its message). */
  readonly fallback: ReactNode | ((error: Error) => ReactNode);
  /** Region name for the console diagnostic ("workbench", "record-row") —
   *  the boundary swallows the crash, so the log line is what a report
   *  will quote. */
  readonly label: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Render-phase crash containment (audit 2026-07-13 T2.2). The row renderers
 * are fed model-shaped record blocks every turn; before this, any throw in
 * one of them unmounted the whole React root — blank window, restart-only.
 * Class component by necessity: error boundaries have no hook equivalent.
 *
 * Deliberately state-only (no reset prop): the app-level fallback offers a
 * reload, and a per-row fallback stands in for just its block, so nothing
 * needs to re-arm in place.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[herta] render crash in ${this.props.label}:`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const f = this.props.fallback;
      return typeof f === "function" ? f(error) : f;
    }
    return this.props.children;
  }
}
