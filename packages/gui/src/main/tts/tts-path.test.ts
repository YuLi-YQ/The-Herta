import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTtsModelRoots,
  resolveVoiceCloneReference,
  ttsBundleComplete,
  ttsBundleCompleteAsync,
  voiceModelStoreRoot,
} from "./tts-path.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-tts-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bundle with every file the Kokoro runtime opens. */
function makeBundle(root: string, opts: { omit?: string } = {}): void {
  const files = [
    "model.int8-81mb.onnx",
    "voices.bin",
    "frontend/tokens.txt",
    "frontend/lexicon-us-en.txt",
    "frontend/lexicon-zh.txt",
    "frontend/phone-zh.fst",
    "frontend/date-zh.fst",
    "frontend/number-zh.fst",
  ].filter((f) => f !== opts.omit);
  for (const rel of files) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
  }
  if (opts.omit !== "frontend/espeak-ng-data") {
    mkdirSync(join(root, "frontend", "espeak-ng-data"), { recursive: true });
  }
}

describe("resolveTtsModelRoots (ADR 0061)", () => {
  it("dev: the downloaded copy first, then the workspace's data/tts/<bundle id>", () => {
    expect(
      resolveTtsModelRoots({
        userDataPath: "/home/u/AppData/herta",
        isPackaged: false,
        workspaceRoot: "/ws",
      }),
    ).toEqual([
      join("/home/u/AppData/herta", "tts", "herta-best-e72"),
      join("/ws", "data", "tts", "herta-best-e72"),
    ]);
  });

  it("packaged: ONLY the downloaded copy — the installer carries no bundle", () => {
    expect(
      resolveTtsModelRoots({
        userDataPath: "/home/u/AppData/herta",
        isPackaged: true,
        workspaceRoot: "/ws",
      }),
    ).toEqual([join("/home/u/AppData/herta", "tts", "herta-best-e72")]);
  });

  it("the store root is <userData>/tts", () => {
    expect(voiceModelStoreRoot("/home/u/AppData/herta")).toBe(
      join("/home/u/AppData/herta", "tts"),
    );
  });
});

describe("resolveVoiceCloneReference (ADR 0062)", () => {
  it("packaged: <resources>/voice-clone; dev: the workspace's data/voice-clone", () => {
    expect(
      resolveVoiceCloneReference({
        isPackaged: true,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/app/resources", "voice-clone", "herta-reference.wav"));
    expect(
      resolveVoiceCloneReference({
        isPackaged: false,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/ws", "data", "voice-clone", "herta-reference.wav"));
  });
});

/** The two checks answer every question the same way: the sync one (Settings
 *  reads, a download landing) and the async one (the launch probe, off the
 *  main thread). Every case below runs through both. */
const CHECKS: ReadonlyArray<
  readonly [string, (root: string) => Promise<boolean>]
> = [
  ["ttsBundleComplete", async (root) => ttsBundleComplete(root)],
  ["ttsBundleCompleteAsync", ttsBundleCompleteAsync],
];

const manifestFor = (
  files: ReadonlyArray<{ path: string; bytes: number }>,
): string =>
  JSON.stringify({
    schema: 1,
    release: "r",
    model: "model.int8-81mb.onnx",
    runtime_voice: "voices.bin",
    files: files.map((f) => ({ ...f, sha256: "0".repeat(64) })),
  });

for (const [name, complete] of CHECKS) {
  describe(name, () => {
    it("true for a complete bundle", async () => {
      const root = tmp();
      makeBundle(root);
      expect(await complete(root)).toBe(true);
    });

    it("false when the model, the voicepack, a lexicon or an FST is missing", async () => {
      for (const omit of [
        "model.int8-81mb.onnx",
        "voices.bin",
        "frontend/lexicon-zh.txt",
        "frontend/phone-zh.fst",
      ]) {
        const root = tmp();
        makeBundle(root, { omit });
        expect(await complete(root), `omitting ${omit}`).toBe(false);
      }
    });

    it("false without the espeak data directory", async () => {
      const root = tmp();
      makeBundle(root, { omit: "frontend/espeak-ng-data" });
      expect(await complete(root)).toBe(false);
    });

    it("false — never throws — for a path that does not exist at all", async () => {
      expect(await complete(join(tmp(), "nope"))).toBe(false);
    });

    it("false when a required entry is a DIRECTORY rather than a file", async () => {
      const root = tmp();
      makeBundle(root, { omit: "model.int8-81mb.onnx" });
      mkdirSync(join(root, "model.int8-81mb.onnx"));
      expect(await complete(root)).toBe(false);
    });
  });

  describe(`${name} — sizes, not just presence (ADR 0061 §4.4)`, () => {
    it("false when a required file is empty — a truncated write that survived the rename", async () => {
      const root = tmp();
      makeBundle(root);
      writeFileSync(join(root, "voices.bin"), "");
      expect(await complete(root)).toBe(false);
    });

    it("false when the bundle's own manifest disagrees with a file's size; true when it agrees", async () => {
      const root = tmp();
      makeBundle(root);
      const at = join(root, "manifest.json");
      writeFileSync(at, manifestFor([{ path: "voices.bin", bytes: 2 }]));
      expect(await complete(root)).toBe(false);
      writeFileSync(at, manifestFor([{ path: "voices.bin", bytes: 1 }]));
      expect(await complete(root)).toBe(true);
    });

    it("false for a manifest listing a file that is not there, one stepping outside the bundle, one that does not parse, and one that is a directory", async () => {
      for (const [what, write] of [
        [
          "a missing file",
          (r: string) =>
            writeFileSync(
              join(r, "manifest.json"),
              manifestFor([{ path: "frontend/gone.bin", bytes: 1 }]),
            ),
        ],
        [
          "a path out of the bundle",
          (r: string) =>
            writeFileSync(
              join(r, "manifest.json"),
              manifestFor([{ path: "../voices.bin", bytes: 1 }]),
            ),
        ],
        [
          "malformed JSON",
          (r: string) => writeFileSync(join(r, "manifest.json"), "{ nope"),
        ],
        ["a directory", (r: string) => mkdirSync(join(r, "manifest.json"))],
      ] as const) {
        const root = tmp();
        makeBundle(root);
        write(root);
        expect(await complete(root), what).toBe(false);
      }
    });
  });
}
