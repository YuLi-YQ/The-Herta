import { configDefaults, defineConfig } from "vitest/config";
import { DOM_FREE_TESTS } from "./vitest.dom-free.js";

export default defineConfig({
  test: {
    environment: "jsdom",
    // The temp-dir tracker first (it wraps the fs builtins before any test
    // module loads), then the React commit hook (react-dom looks for it once,
    // at load — and setup-tests.ts loads react-dom), then the jest-dom
    // matchers.
    setupFiles: [
      "../core/test-setup/track-tmp-dirs.ts",
      "./src/renderer/test-utils/react-commit-hook.ts",
      "./src/renderer/setup-tests.ts",
    ],
    globals: false,
    // Every source tree that holds tests. `src/shared/` was missing
    // (2026-09-10): the external-link allowlist test added on 09-09 matched
    // no project and never ran — green by absence. `vitest-dom-free.test.ts`
    // now also checks that every test file under src/ is reached by one
    // project or the other.
    include: [
      "src/renderer/**/*.test.{ts,tsx}",
      "src/main/**/*.test.{ts,tsx}",
      "src/shared/**/*.test.{ts,tsx}",
    ],
    // The dom-free files run in the root config's `gui-node` project instead
    // (node environment, no setup file). Excluded from the SAME array they are
    // included by, so the two projects can never overlap or leave a gap —
    // `src/vitest-dom-free.test.ts` guards both directions.
    exclude: [...configDefaults.exclude, ...DOM_FREE_TESTS],
  },
});
