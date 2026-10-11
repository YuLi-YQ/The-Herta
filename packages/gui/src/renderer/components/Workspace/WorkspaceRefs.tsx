import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useMemo,
  useRef,
} from "react";

interface WorkspaceRefsValue {
  readonly composerRef: RefObject<HTMLFormElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  readonly sendButtonRef: RefObject<HTMLButtonElement>;
}

const Ctx = createContext<WorkspaceRefsValue | null>(null);

export function WorkspaceRefsProvider(props: {
  readonly children: ReactNode;
}): JSX.Element {
  const composerRef = useRef<HTMLFormElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  // ONE value object for the provider's life. A fresh `{…}` per render made
  // every consumer — Conversation and Composer among them — re-render whenever
  // this provider's parent did (a sidebar-search keystroke, the sidebar
  // collapsing, Settings opening), straight past their `memo` (perf audit
  // 2026-09-20). The refs themselves never change identity.
  const value = useMemo(() => ({ composerRef, overlayRef, sendButtonRef }), []);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function useWorkspaceRefs(): WorkspaceRefsValue {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error(
      "useWorkspaceRefs must be used within a WorkspaceRefsProvider",
    );
  }
  return v;
}
