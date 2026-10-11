import { type RenderResult, render } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import type { Locale } from "../ipc/bridge-types.js";
import { LocaleProvider } from "./LocaleProvider.js";

/**
 * Render `ui` inside a controlled LocaleProvider (default locale "en"), via
 * testing-library's `wrapper` option. The wrapper is preserved across
 * `rerender`, so a re-render NEVER remounts the tree — component state
 * (ConnectStation's exit-animation mount, the modal's focus transition) is
 * kept. Pass `ui` BARE to `rerender(...)`; the provider is re-applied
 * automatically. A component calling `useLocale().setLocale(...)` flips the
 * rendered locale live, just like the real App.
 */
export function renderWithLocale(
  ui: ReactNode,
  opts: { locale?: Locale } = {},
): RenderResult {
  const initial = opts.locale ?? "en";
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    const [locale, setLocale] = useState<Locale>(initial);
    return (
      <LocaleProvider locale={locale} onLocaleChange={setLocale}>
        {children}
      </LocaleProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}
