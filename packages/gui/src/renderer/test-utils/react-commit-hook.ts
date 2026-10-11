/**
 * A minimal React DevTools global hook for the jsdom tests — the seam the
 * render census (render-census.ts) listens on.
 *
 * It must exist BEFORE react-dom loads: react-dom looks for
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` once, at module load, and never again.
 * setup-tests.ts imports Testing Library, which loads react-dom, so this
 * file is the FIRST jsdom setup file (packages/gui/vitest.config.ts). React
 * then calls `onCommitFiberRoot` after every commit; with no listener
 * registered that is one empty loop. Imports nothing — importing React here
 * would load it before the hook exists.
 */

type CommitListener = (root: unknown) => void;

export interface CommitHook {
  readonly supportsFiber: true;
  readonly inject: (renderer: unknown) => number;
  readonly onCommitFiberRoot: (rendererId: number, root: unknown) => void;
  readonly listeners: Set<CommitListener>;
}

let renderers = 0;
const hook: CommitHook = {
  supportsFiber: true,
  inject: () => {
    renderers += 1;
    return renderers;
  },
  onCommitFiberRoot: (_rendererId, root) => {
    for (const listen of hook.listeners) listen(root);
  },
  listeners: new Set(),
};

(
  globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: CommitHook }
).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
