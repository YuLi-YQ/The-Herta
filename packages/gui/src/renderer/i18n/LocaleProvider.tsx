import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Locale } from "../ipc/bridge-types.js";
import type { MessageKey } from "./keys.js";
import { en } from "./messages/en.js";
import { zh } from "./messages/zh.js";

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { zh, en };

export type TFn = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (l: Locale) => void;
  readonly t: TFn;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * CONTROLLED provider: the owner holds the `locale` state and passes it in.
 * No internal state and no `key`-based remount — a locale change is a plain
 * re-render, so the rest of the tree (the bridge provider + its session stores)
 * stays mounted across a language switch. Remounting it would drop the stores
 * and miss the backend's one-shot `session:reset`, breaking the launch
 * bootstrap (the connect screen would vanish). `onLocaleChange` is invoked by
 * the in-app Language selector; the owner updates its state (and persists).
 */
export interface LocaleProviderProps {
  readonly locale: Locale;
  readonly onLocaleChange: (l: Locale) => void;
  readonly children: ReactNode;
}

/**
 * A `t` bound to a SPECIFIC language, independent of the UI locale. The
 * provider uses this for the UI-locale `t`; record-surface components (the
 * activity line) call it with the ACTIVE SESSION's interaction language so
 * their labels track the session, not the chrome — mirroring the 板砖→Brick
 * alias (ADR 0015 §4) and the CLI's system-label localization (ADR 0018).
 * Pure — safe to memoize on `lang`.
 */
export function makeT(lang: Locale): TFn {
  const catalog = CATALOGS[lang];
  return (key, params) => interpolate(catalog[key] ?? key, params);
}

export function LocaleProvider(props: LocaleProviderProps): JSX.Element {
  const { locale, onLocaleChange } = props;
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale: onLocaleChange, t: makeT(locale) }),
    [locale, onLocaleChange],
  );
  return (
    <LocaleContext.Provider value={value}>
      {props.children}
    </LocaleContext.Provider>
  );
}

function useLocaleContext(): LocaleContextValue {
  const v = useContext(LocaleContext);
  if (v === null) {
    throw new Error("useT/useLocale must be used within a LocaleProvider");
  }
  return v;
}

export function useT(): TFn {
  return useLocaleContext().t;
}

export function useLocale(): {
  locale: Locale;
  setLocale: (l: Locale) => void;
} {
  const { locale, setLocale } = useLocaleContext();
  return { locale, setLocale };
}
