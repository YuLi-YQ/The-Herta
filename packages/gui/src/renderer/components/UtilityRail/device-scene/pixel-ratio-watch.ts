/**
 * Notice a devicePixelRatio change that comes without a resize (ADR 0057
 * §6.5): a window dragged to a monitor with another scale factor keeps its
 * CSS size, so the ResizeObserver stays silent and the drawing buffer kept
 * the old ratio until the next layout change. The standard trick: a media
 * query pinned to the current ratio fires `change` once when it stops
 * matching; re-arm it at the new ratio each time. Returns the unwatch.
 */
export function watchDevicePixelRatio(
  win: {
    readonly devicePixelRatio: number;
    matchMedia: (query: string) => MediaQueryList;
  },
  onChange: () => void,
): () => void {
  let list: MediaQueryList | null = null;
  const listener = (): void => {
    arm();
    onChange();
  };
  const arm = (): void => {
    list?.removeEventListener("change", listener);
    list = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    list.addEventListener("change", listener);
  };
  arm();
  return () => {
    list?.removeEventListener("change", listener);
    list = null;
  };
}
