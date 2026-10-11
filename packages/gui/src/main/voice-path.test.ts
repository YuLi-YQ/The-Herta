import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveVoiceFilePath,
  resolveVoiceRoot,
  voiceRootFor,
} from "./voice-path.js";

describe("voiceRootFor", () => {
  it("points at <workspaceRoot>/data/voice", () => {
    expect(voiceRootFor("/ws")).toBe(join("/ws", "data", "voice"));
  });
});

describe("resolveVoiceRoot (packaged-aware, 2026-07-06)", () => {
  it("dev: the workspace's data/voice", () => {
    expect(
      resolveVoiceRoot({
        isPackaged: false,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/ws", "data", "voice"));
  });

  it("packaged: the bundled resources copy (clips ship with the app)", () => {
    expect(
      resolveVoiceRoot({
        isPackaged: true,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/app/resources", "voice"));
  });
});

describe("resolveVoiceFilePath", () => {
  const root = resolve("/ws", "data", "voice");

  it("maps a normal clip URL to a file under the root", () => {
    expect(
      resolveVoiceFilePath(
        "herta-voice://clip/openings/004-late-night-audit.opus",
        root,
      ),
    ).toBe(join(root, "openings", "004-late-night-audit.opus"));
  });

  it("percent-decodes segments (Chinese particle categories)", () => {
    const url = `herta-voice://clip/particle/${encodeURIComponent("嗯")}/01.opus`;
    expect(resolveVoiceFilePath(url, root)).toBe(
      join(root, "particle", "嗯", "01.opus"),
    );
  });

  it("never resolves outside the root (../ / %2e%2e / absolute attempts)", () => {
    // The security invariant: whatever the input, the result is either null or a
    // path under the root. `new URL` clamps `..`/`%2e%2e` to the root and strips
    // leading slashes; the resolve()+startsWith guard backstops anything that
    // slips past (e.g. a platform absolute path). Both keep us in-root.
    for (const url of [
      "herta-voice://clip/%2e%2e/%2e%2e/secret.opus",
      "herta-voice://clip/openings/../../../../etc/passwd",
      "herta-voice://clip/../../x.opus",
      `herta-voice://clip/${encodeURIComponent("..")}/语音-evil/x.opus`,
    ]) {
      const out = resolveVoiceFilePath(url, root);
      expect(out === null || out.startsWith(root + sep)).toBe(true);
    }
  });

  it("rejects an empty path", () => {
    expect(resolveVoiceFilePath("herta-voice://clip/", root)).toBeNull();
  });
});
