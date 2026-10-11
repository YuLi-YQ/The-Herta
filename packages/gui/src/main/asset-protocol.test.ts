import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveDeviceSceneAssetPath,
  resolveDeviceSceneRoot,
} from "./asset-protocol.js";

const ROOT = resolve("/app/out/renderer/device-scene");

describe("resolveDeviceSceneAssetPath (ADR 0057 §3 — the guard)", () => {
  it("maps a well-formed asset URL under the root", () => {
    expect(
      resolveDeviceSceneAssetPath(
        "herta-asset://device-scene/device.glb",
        ROOT,
      ),
    ).toBe(join(ROOT, "device.glb"));
    expect(
      resolveDeviceSceneAssetPath(
        "herta-asset://device-scene/basis/basis_transcoder.wasm",
        ROOT,
      ),
    ).toBe(join(ROOT, "basis", "basis_transcoder.wasm"));
  });

  it("cannot be walked out of the root: dot segments collapse at the URL, and what survives stays inside", () => {
    // The WHATWG parser folds `..` (and `%2e%2e`) against the URL root before
    // the guard ever sees a path, so a traversal lands on a path INSIDE the
    // asset root — a non-existent file, a 404 — never on a sibling tree.
    for (const url of [
      "herta-asset://device-scene/../../main/index.js",
      "herta-asset://device-scene/%2e%2e/%2e%2e/main/index.js",
      "herta-asset://device-scene/basis/../../../main/index.js",
    ]) {
      const out = resolveDeviceSceneAssetPath(url, ROOT);
      expect(out).toBe(join(ROOT, "main", "index.js"));
      expect(out?.startsWith(ROOT + sep)).toBe(true);
    }
    // A backslash is a separator only on Windows, where the parser would not
    // fold it — refused outright so the guard reads the same on every OS.
    expect(
      resolveDeviceSceneAssetPath(
        "herta-asset://device-scene/basis/..%5c..%5csecret.png",
        ROOT,
      ),
    ).toBeNull();
    expect(
      resolveDeviceSceneAssetPath("herta-asset://device-scene/a%00.png", ROOT),
    ).toBeNull();
  });

  it("refuses extensions outside the allowlist — the scheme serves scene assets, not files", () => {
    for (const name of [
      "settings.json.bak",
      "notes.txt",
      "a.html",
      "x.exr",
      "noext",
    ]) {
      expect(
        resolveDeviceSceneAssetPath(`herta-asset://device-scene/${name}`, ROOT),
      ).toBeNull();
    }
    expect(
      resolveDeviceSceneAssetPath("herta-asset://device-scene/a.JSON", ROOT),
    ).toBe(join(ROOT, "a.JSON"));
  });

  it("refuses another host, another scheme, an empty path and a malformed URL", () => {
    expect(
      resolveDeviceSceneAssetPath("herta-asset://elsewhere/device.glb", ROOT),
    ).toBeNull();
    expect(
      resolveDeviceSceneAssetPath(
        "herta-voice://device-scene/device.glb",
        ROOT,
      ),
    ).toBeNull();
    expect(
      resolveDeviceSceneAssetPath("herta-asset://device-scene/", ROOT),
    ).toBeNull();
    expect(resolveDeviceSceneAssetPath("not a url", ROOT)).toBeNull();
  });

  it("never resolves to the root itself", () => {
    expect(
      resolveDeviceSceneAssetPath("herta-asset://device-scene/.", ROOT),
    ).toBeNull();
  });

  it("a sibling tree sharing the root's prefix is unreachable", () => {
    // `/app/out/renderer/device-scene-evil/x.png` starts with the root string
    // but not with root + separator; the parser folds the `..` so the request
    // resolves INSIDE the root instead.
    const sibling = `${ROOT}-evil${sep}x.png`;
    expect(sibling.startsWith(ROOT)).toBe(true);
    expect(
      resolveDeviceSceneAssetPath(
        "herta-asset://device-scene/../device-scene-evil/x.png",
        ROOT,
      ),
    ).toBe(join(ROOT, "device-scene-evil", "x.png"));
  });
});

describe("resolveDeviceSceneRoot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herta-asset-root-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("picks the first existing candidate, in order", () => {
    const built = join(dir, "out", "renderer", "device-scene");
    const source = join(dir, "src", "renderer", "public", "device-scene");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "device.glb"), "x");
    expect(resolveDeviceSceneRoot([built, source])).toBe(source);
    mkdirSync(built, { recursive: true });
    expect(resolveDeviceSceneRoot([built, source])).toBe(built);
  });

  it("returns null when nothing exists — the handler then refuses everything", () => {
    expect(resolveDeviceSceneRoot([join(dir, "nope")])).toBeNull();
  });
});
