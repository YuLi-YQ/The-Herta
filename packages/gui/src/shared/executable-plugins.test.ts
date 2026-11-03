import { describe, expect, it, vi } from "vitest";
import {
  EXECUTABLE_PLUGIN_CAPABILITY_NAMES,
  EXECUTABLE_PLUGIN_LIMITS,
  ExecutablePluginFault,
  executablePluginActionKey,
  parseExecutablePluginManifest,
  parseExecutablePluginPackage,
} from "./executable-plugins.js";

function fixture() {
  return {
    manifest: {
      schemaVersion: 2, apiVersion: 1, id: "example.summary", name: "文件摘要", version: "1.0.0",
      description: "读取允许的项目文件，并生成可编辑草稿。", entry: "src/main.mjs",
      capabilities: [{ name: "workspace.readText" }, { name: "draft.append" }],
      actions: [{ id: "summarize", title: "生成摘要", scope: "workbench", export: "summarize",
        inputs: [{ id: "path", label: "文件路径", type: "text", required: true, maxLength: 160 }],
        capabilities: ["workspace.readText", "draft.append"] }],
    },
    files: [
      { path: "src/main.mjs", source: "import { heading } from './helper.js';\nexport async function summarize(input, api) { return heading(await api.workspace.readText(input.path)); }\n" },
      { path: "src/helper.js", source: "export const heading = text => `摘要：${text}`;\n" },
    ],
  };
}
function parse(raw: unknown) { return parseExecutablePluginPackage(JSON.stringify(raw)); }
function manifest(raw: unknown) { return parseExecutablePluginManifest(JSON.stringify(raw)); }
function expectFault(run: () => unknown, code: ExecutablePluginFault["code"]) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ExecutablePluginFault);
    expect((error as ExecutablePluginFault).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("v2 executable plugin data contract", () => {
  it("preserves JavaScript as inert text and normalizes unordered module/capability lists", () => {
    const raw = fixture(), parsed = parse(raw);
    expect(parsed.manifest.schemaVersion).toBe(2);
    expect(parsed.manifest.apiVersion).toBe(1);
    expect(parsed.manifest.capabilities.map((cap) => cap.name)).toEqual(["draft.append", "workspace.readText"]);
    expect(parsed.manifest.actions[0]?.capabilities).toEqual(["draft.append", "workspace.readText"]);
    expect(parsed.files.map((file) => file.path)).toEqual(["src/helper.js", "src/main.mjs"]);
    expect(parsed.files[1]?.source).toBe(raw.files[0]?.source);
    raw.files.reverse(); raw.manifest.capabilities.reverse(); raw.manifest.actions[0]!.capabilities.reverse();
    expect(JSON.stringify(parse(raw))).toBe(JSON.stringify(parsed));
    expect(manifest(raw.manifest)).toEqual(parsed.manifest);
  });

  it("makes all returned objects owned, null-prototype and recursively frozen", () => {
    const raw = fixture(), parsed = parse(raw);
    const visit = (value: unknown): void => {
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBeNull();
        Object.values(value).forEach(visit);
      }
    };
    visit(parsed);
    raw.manifest.actions[0]!.title = "changed";
    raw.files[0]!.source = "changed";
    expect(parsed.manifest.actions[0]?.title).toBe("生成摘要");
    expect(() => Object.assign(parsed.manifest, { id: "other.plugin" })).toThrow(TypeError);
    expect(() => (parsed.files as unknown[]).push({})).toThrow(TypeError);
  });

  it("does not evaluate or import source even if it would throw or call native APIs", () => {
    const raw = fixture();
    raw.files[0]!.source = "throw new Error('not executed'); require('node:fs'); globalThis.process.exit(1);";
    expect(parse(raw).files.find((file) => file.path === raw.manifest.entry)?.source).toBe(raw.files[0]?.source);
  });

  it("does not claim syntax, imports or declared exports are executable", () => {
    const raw = fixture(); raw.files[0]!.source = "this is not valid JavaScript }";
    expect(parse(raw).manifest.actions[0]?.export).toBe("summarize");
  });

  it("allows zero-capability ordinary-JS actions in both areas", () => {
    const raw = fixture(); raw.manifest.capabilities = []; raw.manifest.actions[0]!.capabilities = [];
    raw.manifest.actions[0]!.scope = "both";
    expect(parse(raw).manifest.actions[0]?.scope).toBe("both");
  });

  it("provides stable disjoint names, without trusting a bare action as a tool name", () => {
    expect(executablePluginActionKey("example.summary", "read-file")).toBe("herta.plugin.v2:example.summary:read-file");
    expect(executablePluginActionKey("other.summary", "read-file")).not.toBe(executablePluginActionKey("example.summary", "read-file"));
    expectFault(() => executablePluginActionKey("a:b", "read-file"), "invalid-value");
    expectFault(() => executablePluginActionKey("example.summary", "constructor"), "invalid-value");
  });

  it.each(["schemaVersion", "apiVersion"])("denies unsupported %s", (key) => {
    const raw = fixture(); (raw.manifest as Record<string, unknown>)[key] = 999;
    expectFault(() => parse(raw), "unsupported-version");
  });

  it.each(["enabled", "contentHash", "installedAt", "grant", "sessionId", "readOnly", "views", "hostId"])("does not accept host-owned or unsupported manifest field %s", (key) => {
    const raw = fixture(); Object.assign(raw.manifest, { [key]: "untrusted claim" });
    expectFault(() => parse(raw), "unsupported-field");
  });

  it("denies unknown fields at the envelope, file, action, input and capability boundaries", () => {
    const edits = [
      (raw: ReturnType<typeof fixture>) => Object.assign(raw, { signature: "fake" }),
      (raw: ReturnType<typeof fixture>) => Object.assign(raw.files[0]!, { url: "https://example.com/code.js" }),
      (raw: ReturnType<typeof fixture>) => Object.assign(raw.manifest.actions[0]!, { readOnly: true }),
      (raw: ReturnType<typeof fixture>) => Object.assign(raw.manifest.actions[0]!.inputs[0]!, { pattern: "(.+)+" }),
      (raw: ReturnType<typeof fixture>) => Object.assign(raw.manifest.capabilities[0]!, { grant: true }),
    ];
    for (const edit of edits) { const raw = fixture(); edit(raw); expectFault(() => parse(raw), "unsupported-field"); }
  });

  it("fails absent required fields instead of inventing defaults", () => {
    for (const key of ["entry", "capabilities", "actions", "description"] as const) {
      const raw = fixture(); delete (raw.manifest as Partial<typeof raw.manifest>)[key];
      expect(() => parse(raw)).toThrow(ExecutablePluginFault);
    }
    const raw = fixture(); delete (raw.manifest.actions[0] as { inputs?: unknown }).inputs;
    expectFault(() => parse(raw), "invalid-type");
  });

  it.each(["1", "1.0", "01.0.0", "1.0.0-beta", "1.0.0+build", "1.0.0 "])("rejects non-baseline version %s", (version) => {
    const raw = fixture(); raw.manifest.version = version; expectFault(() => parse(raw), "invalid-value");
  });

  it.each(["run();process.exit()", "module.run", "a b", "constructor", "__proto__", "prototype"])("rejects an unsafe export identifier %s", (name) => {
    const raw = fixture(); raw.manifest.actions[0]!.export = name; expectFault(() => parse(raw), "invalid-value");
  });
});

describe("JSON-only boundary", () => {
  it("rejects objects, getter-bearing arrays and proxies without executing any hooks", () => {
    const hook = vi.fn(() => { throw new Error("must not execute"); });
    const getterObject = Object.defineProperty({}, "manifest", { get: hook });
    const getterArray = Object.defineProperty([], "0", { get: hook });
    const proxy = new Proxy({}, { get: hook, getPrototypeOf: hook, ownKeys: hook, getOwnPropertyDescriptor: hook });
    const withToJSON = { toJSON: hook };
    for (const value of [fixture(), getterObject, getterArray, proxy, withToJSON, Object.create(null), new Date(), 42, null, undefined]) {
      expectFault(() => parseExecutablePluginPackage(value), "invalid-type");
      expectFault(() => parseExecutablePluginManifest(value), "invalid-type");
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(["", "{", "[]", "null", "{\"a\":}", "{\"a\":1,}", "{\"a\":\"unterminated}", "[1,,2]", "true"])("rejects invalid JSON or non-object JSON %s", (json) => {
    expect(() => parseExecutablePluginPackage(json)).toThrow(ExecutablePluginFault);
  });

  it("rejects duplicate keys including escaped spellings before JSON.parse can hide them", () => {
    const raw = JSON.stringify(fixture());
    expectFault(() => parseExecutablePluginPackage(raw.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2')), "duplicate");
    expectFault(() => parseExecutablePluginPackage(raw.replace('"schemaVersion":2', '"schemaVersion":1,"schema\\u0056ersion":2')), "duplicate");
    expectFault(() => parseExecutablePluginPackage('{"files":[],"files":[]}'), "duplicate");
  });

  it.each(["__proto__", "constructor", "prototype"])("denies dangerous object key %s without prototype pollution", (key) => {
    const raw = JSON.stringify(fixture()).replace('"schemaVersion":2', `"schemaVersion":2,"${key}":{"polluted":true}`);
    expectFault(() => parseExecutablePluginPackage(raw), "unsupported-field");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("does not mistake escaped source contents for envelope syntax or keys", () => {
    const raw = fixture(); raw.files[0]!.source = 'export const x = "\\\""; // {"constructor": 1, "constructor": 2}\nconst y = ["a", {"b":2}];';
    expect(parse(raw).files.find((file) => file.path === raw.manifest.entry)?.source).toBe(raw.files[0]?.source);
  });

  it("bounds nesting, entry counts and text size before parsing an untrusted object graph", () => {
    expectFault(() => parseExecutablePluginPackage("[".repeat(17) + "0" + "]".repeat(17)), "limit-exceeded");
    expectFault(() => parseExecutablePluginPackage(`[${"0,".repeat(EXECUTABLE_PLUGIN_LIMITS.jsonSeparators + 1)}0]`), "limit-exceeded");
    expectFault(() => parseExecutablePluginPackage(" ".repeat(EXECUTABLE_PLUGIN_LIMITS.jsonBytes + 1)), "limit-exceeded");
    expectFault(() => parseExecutablePluginManifest(" ".repeat(EXECUTABLE_PLUGIN_LIMITS.manifestBytes + 1)), "limit-exceeded");
  });

  it("rejects actual and escaped lone surrogates rather than replacing them", () => {
    const raw = fixture(); raw.files[0]!.source = "\ud800";
    expectFault(() => parse(raw), "invalid-value");
    raw.files[0]!.source = "\udc00"; expectFault(() => parse(raw), "invalid-value");
    raw.files[0]!.source = "ok"; raw.manifest.name = "\ud800"; expectFault(() => parse(raw), "invalid-value");
    expectFault(() => parseExecutablePluginPackage("\ud800"), "invalid-value");
    raw.manifest.name = "黑塔 🌌"; raw.files[0]!.source = "export const sky = '🌌';";
    expect(parse(raw).manifest.name).toBe("黑塔 🌌");
  });

  it("does not echo private source values in errors", () => {
    const raw = fixture(); Object.assign(raw.manifest, { "SECRET-WOULD-BE-PRIVATE": "PRIVATE-SOURCE" });
    try { parse(raw); } catch (error) {
      expect(String(error)).not.toContain("SECRET"); expect(String(error)).not.toContain("PRIVATE");
      expect((error as ExecutablePluginFault).path).toBe("$.manifest");
    }
  });
});

describe("portable bounded module packages", () => {
  it.each(["../main.js", "./main.js", "/main.js", "C:/main.js", "C:main.js", "src\\main.js", "src//main.js", "src/../main.js", "src/main.js.", "src/main.js ", "src /main.js", "src/main.js:stream", "https://a.test/main.js", "src/%2e%2e/main.js", "node:fs", "src/main.ts", "src/main.JS", "src/.hidden.js", "src/CON.js", "NUL/main.js", "aux.mjs", "COM1.js", "lpt9/helper.js", "PRN.extra.js"])("rejects unsafe/nonportable module path %s", (path) => {
    const raw = fixture(); raw.files[0]!.path = path; raw.manifest.entry = path;
    expectFault(() => parse(raw), "invalid-value");
  });

  it("detects path duplicates, case collisions, entry casing and file/directory prefix collisions", () => {
    const raw = fixture(); raw.files.push({ ...raw.files[0]! });
    expectFault(() => parse(raw), "duplicate");
    raw.files.pop(); raw.files.push({ path: "SRC/MAIN.mjs", source: "" });
    expectFault(() => parse(raw), "duplicate");
    raw.files.pop(); raw.manifest.entry = "SRC/main.mjs";
    expectFault(() => parse(raw), "missing-file");
    raw.manifest.entry = "a.js";
    raw.files = [{ path: "a.js", source: "" }, { path: "a.js-other.js", source: "" }, { path: "a.js/child.js", source: "" }];
    expectFault(() => parse(raw), "invalid-value");
  });

  it("requires an exact included entry and refuses opaque/binary file encodings", () => {
    const raw = fixture(); raw.manifest.entry = "missing.js";
    expectFault(() => parse(raw), "missing-file");
    raw.manifest.entry = "src/main.mjs"; Object.assign(raw.files[0]!, { source: { base64: "YWJj" } });
    expectFault(() => parse(raw), "invalid-type");
  });

  it("checks module limits by UTF-8 bytes rather than UTF-16 length", () => {
    const raw = fixture(); raw.files = [{ path: raw.manifest.entry, source: "a".repeat(EXECUTABLE_PLUGIN_LIMITS.moduleBytes) }];
    expect(parse(raw).files[0]?.source.length).toBe(EXECUTABLE_PLUGIN_LIMITS.moduleBytes);
    raw.files[0]!.source += "a"; expectFault(() => parse(raw), "limit-exceeded");
    raw.files[0]!.source = "字".repeat(Math.floor(EXECUTABLE_PLUGIN_LIMITS.moduleBytes / 3) + 1);
    expectFault(() => parse(raw), "limit-exceeded");
    raw.files[0]!.source = "🌌".repeat(EXECUTABLE_PLUGIN_LIMITS.moduleBytes / 4 + 1);
    expectFault(() => parse(raw), "limit-exceeded");
  });

  it("bounds aggregate source and module count independently of each file", () => {
    const raw = fixture(); raw.manifest.entry = "file0.js";
    raw.files = Array.from({ length: 4 }, (_, index) => ({ path: `file${index}.js`, source: "a".repeat(EXECUTABLE_PLUGIN_LIMITS.moduleBytes) }));
    expect(parse(raw).files).toHaveLength(4);
    raw.files.push({ path: "more.js", source: "a" }); expectFault(() => parse(raw), "limit-exceeded");
    raw.files = Array.from({ length: EXECUTABLE_PLUGIN_LIMITS.modules + 1 }, (_, index) => ({ path: `file${index}.js`, source: "" }));
    expectFault(() => parse(raw), "limit-exceeded");
  });
});

describe("capabilities and explicit action inputs", () => {
  it("keeps the known capability vocabulary explicit and never accepts wildcard/native permissions", () => {
    expect(EXECUTABLE_PLUGIN_CAPABILITY_NAMES).toContain("artifacts.create");
    for (const name of ["*", "fs", "process", "ipc", "workspace.write", "model.key", "network.*"]) {
      const raw = fixture(); raw.manifest.capabilities[0]!.name = name;
      expectFault(() => parse(raw), "invalid-value");
    }
  });

  it("requires action capabilities to be declared, unique and used", () => {
    const raw = fixture(); raw.manifest.actions[0]!.capabilities.push("storage.get");
    expectFault(() => parse(raw), "invalid-value");
    raw.manifest.actions[0]!.capabilities.pop(); raw.manifest.actions[0]!.capabilities.push("draft.append");
    expectFault(() => parse(raw), "duplicate");
    raw.manifest.actions[0]!.capabilities.pop(); raw.manifest.capabilities.push({ name: "storage.get" });
    expectFault(() => parse(raw), "invalid-value");
    raw.manifest.capabilities.pop(); raw.manifest.capabilities.push({ name: "draft.append" });
    expectFault(() => parse(raw), "duplicate");
  });

  it.each(["chat", "both"])("rejects workspace/command capability requests from %s actions", (scope) => {
    for (const name of ["workspace.readText", "workspace.proposePatch", "commands.run"]) {
      const raw = fixture(); raw.manifest.actions[0]!.scope = scope;
      raw.manifest.capabilities = [{ name }]; raw.manifest.actions[0]!.capabilities = [name];
      expectFault(() => parse(raw), "invalid-value");
    }
  });

  it("accepts explicit normalized HTTPS network requests without interpreting them as grants", () => {
    const raw = fixture();
    raw.manifest.capabilities = [{ name: "network.request", origins: ["https://z.example", "https://a.example:8443"], methods: ["POST", "GET"] } as { name: string }];
    raw.manifest.actions[0]!.capabilities = ["network.request"]; raw.manifest.actions[0]!.scope = "both";
    expect(parse(raw).manifest.capabilities[0]).toEqual({ name: "network.request", origins: ["https://a.example:8443", "https://z.example"], methods: ["GET", "POST"] });
  });

  it.each(["*", "https://*.example.com", "http://example.com", "file:///path", "https://user:secret@example.com", "https://example.com/path", "https://example.com/", "https://example.com?q=1", "https://example.com#fragment", "https://EXAMPLE.com"])("rejects noncanonical or wildcard network origin %s", (origin) => {
    const raw = fixture();
    raw.manifest.capabilities = [{ name: "network.request", origins: [origin], methods: ["GET"] } as { name: string }];
    raw.manifest.actions[0]!.capabilities = ["network.request"];
    expectFault(() => parse(raw), "invalid-value");
  });

  it("rejects incomplete/duplicate network scopes and arbitrary methods", () => {
    for (const fields of [{}, { origins: [], methods: ["GET"] }, { origins: ["https://a.example"], methods: ["TRACE"] }, { origins: ["https://a.example"], methods: ["GET", "GET"] }, { origins: ["https://a.example", "https://a.example"], methods: ["GET"] }]) {
      const raw = fixture(); raw.manifest.capabilities = [{ name: "network.request", ...fields }];
      raw.manifest.actions[0]!.capabilities = ["network.request"];
      expect(() => parse(raw)).toThrow(ExecutablePluginFault);
    }
  });

  it("supports bounded text, select, number and boolean inputs including falsy defaults", () => {
    const raw = fixture();
    const inputs = [
      { id: "text", label: "说明", type: "text", required: false, maxLength: 200, default: "" },
      { id: "format", label: "格式", type: "select", required: true, options: ["plain", "table"], default: "table" },
      { id: "limit", label: "数量", type: "number", required: true, min: 0, max: 100, integer: true, default: 0 },
      { id: "detailed", label: "详细", type: "boolean", required: false, default: false },
    ];
    Object.assign(raw.manifest.actions[0]!, { inputs });
    expect(parse(raw).manifest.actions[0]?.inputs).toEqual(inputs);
  });

  it("denies invalid input variants, defaults, numbers and cross-variant fields", () => {
    const invalid = [
      { type: "file", required: true },
      { type: "text", required: true, maxLength: 5, default: "" },
      { type: "text", required: false, maxLength: 5, default: "too long" },
      { type: "text", required: false, maxLength: 16001 },
      { type: "text", required: false, maxLength: 5, options: [] },
      { type: "text", required: "false", maxLength: 5 },
      { type: "select", required: true, options: ["a", "a"] },
      { type: "select", required: true, options: ["a"], default: "b" },
      { type: "number", required: true, min: 10, max: 1, integer: true },
      { type: "number", required: true, min: 0, max: 10, integer: true, default: 1.5 },
      { type: "number", required: true, min: 0, max: 10, integer: false, default: 11 },
      { type: "boolean", required: false, default: "false" },
      { type: "boolean", required: false, default: null },
    ];
    for (const fields of invalid) {
      const raw = fixture(); Object.assign(raw.manifest.actions[0]!, { inputs: [{ id: "value", label: "值", ...fields }] });
      expect(() => parse(raw)).toThrow(ExecutablePluginFault);
    }
    const raw = fixture(); Object.assign(raw.manifest.actions[0]!, { inputs: [{ id: "number", label: "值", type: "number", required: true, min: 0, max: 10, integer: false, default: "overflow-marker" }] });
    expectFault(() => parseExecutablePluginPackage(JSON.stringify(raw).replace('"overflow-marker"', "1e400")), "invalid-type");
  });

  it("rejects duplicate action/input identities and excessive action/input counts", () => {
    const raw = fixture(); raw.manifest.actions.push({ ...raw.manifest.actions[0]! });
    expectFault(() => parse(raw), "duplicate");
    raw.manifest.actions.pop(); raw.manifest.actions[0]!.inputs.push({ ...raw.manifest.actions[0]!.inputs[0]! });
    expectFault(() => parse(raw), "duplicate");
    raw.manifest.actions[0]!.inputs = Array.from({ length: 17 }, (_, index) => ({ id: `field${index}`, label: "字段", type: "text", required: false, maxLength: 10 }));
    expectFault(() => parse(raw), "limit-exceeded");
    raw.manifest.actions = Array.from({ length: 25 }, (_, index) => ({ ...raw.manifest.actions[0]!, id: `action${index}`, inputs: [] }));
    expectFault(() => parse(raw), "limit-exceeded");
  });
});
