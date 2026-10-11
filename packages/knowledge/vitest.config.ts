import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Same temp-dir tracker the root projects use, for a standalone run.
    setupFiles: ["../core/test-setup/track-tmp-dirs.ts"],
  },
});
