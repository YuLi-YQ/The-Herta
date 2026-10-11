import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react";
import type { HertaBridge } from "../ipc/bridge-types.js";
import { SessionListStore } from "../store/session-list-store.js";
import { SessionStore } from "../store/session-store.js";

interface HertaBridgeContextValue {
  readonly bridge: HertaBridge;
  readonly sessionStore: SessionStore;
  readonly sessionListStore: SessionListStore;
}

const HertaBridgeContext = createContext<HertaBridgeContextValue | null>(null);

export interface HertaBridgeProviderProps {
  readonly bridge: HertaBridge;
  readonly children: ReactNode;
}

export function HertaBridgeProvider(
  props: HertaBridgeProviderProps,
): JSX.Element {
  const value = useMemo<HertaBridgeContextValue>(
    () => ({
      bridge: props.bridge,
      // Pure construction — no IPC subscription here. StrictMode's dev
      // double-invoke of useMemo can create these twice; keeping the
      // constructor side-effect-free means a discarded instance leaks
      // nothing. Subscription is connected below in the effect.
      sessionStore: new SessionStore(),
      sessionListStore: new SessionListStore(),
    }),
    [props.bridge],
  );

  useEffect(() => {
    // Connect IPC subscriptions in the effect (not the constructor) so the
    // setup → cleanup → setup cycle StrictMode runs in dev disconnects then
    // RE-connects, instead of leaving dead, unsubscribed stores that never
    // receive session:reset / record / agent / turn events.
    const disconnectSession = value.sessionStore.connect(value.bridge);
    const disconnectList = value.sessionListStore.connect(value.bridge);
    return () => {
      disconnectSession();
      disconnectList();
    };
  }, [value]);

  return (
    <HertaBridgeContext.Provider value={value}>
      {props.children}
    </HertaBridgeContext.Provider>
  );
}

export function useHertaBridge(): HertaBridgeContextValue {
  const v = useContext(HertaBridgeContext);
  if (v === null) {
    throw new Error("useHertaBridge must be used within a HertaBridgeProvider");
  }
  return v;
}
