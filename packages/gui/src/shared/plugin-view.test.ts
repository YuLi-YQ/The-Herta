import { describe, expect, it, vi } from "vitest";
import { parsePluginControlledView, PluginViewFault, PLUGIN_VIEW_LIMITS } from "./plugin-view.js";

function fixture() {
  return {
    title: "观测结果 🌌",
    blocks: [
      { type: "text", text: "第一行\n第二行" },
      { type: "code", code: "const value = 42;\n", language: "typescript" },
      { type: "list", items: ["alpha", "beta"] },
      { type: "table", columns: ["名称", "值"], rows: [["count", "42"], ["empty", ""]] },
      { type: "status", tone: "info", text: "只读统计" },
      { type: "fields", items: [{ label: "来源", value: "合成文本" }] },
    ],
    actions: [{ id: "prepare", label: "准备草稿", actionId: "prepare-draft", inputJson: '{ "summary": "统计结果" }' }],
  };
}
const parse = (raw: unknown) => parsePluginControlledView(JSON.stringify(raw));
const minimal = (blocks: unknown[] = [], actions: unknown[] = []) => ({ title: "结果", blocks, actions });

describe("controlled plugin view definition", () => {
  it("accepts the six data-only block kinds and normalizes button input JSON", () => {
    const parsed = parse(fixture());
    expect(parsed.title).toBe("观测结果 🌌");
    expect(parsed.blocks.map((block) => block.type)).toEqual(["text", "code", "list", "table", "status", "fields"]);
    expect(parsed.actions[0]).toEqual({ id: "prepare", label: "准备草稿", actionId: "prepare-draft", inputJson: '{"summary":"统计结果"}' });
  });

  it("creates deeply frozen, null-prototype owned objects without retaining input references", () => {
    const raw = fixture(), parsed = parse(raw);
    const verify = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBeNull();
      Object.values(value).forEach(verify);
    };
    verify(parsed);
    raw.actions[0]!.label = "changed"; raw.blocks[0]!.text = "changed";
    expect(parsed.actions[0]?.label).toBe("准备草稿");
    expect(parsed.blocks[0]).toEqual({ type: "text", text: "第一行\n第二行" });
    expect(() => (parsed.blocks as unknown[]).push({ type: "text", text: "new" })).toThrow(TypeError);
  });

  it("allows an empty view body and empty display values without guessing an input DSL", () => {
    expect(parse(minimal())).toEqual({ title: "结果", blocks: [], actions: [] });
    expect(parse(minimal([{ type: "text", text: "" }, { type: "code", code: "" }, { type: "list", items: [] },
      { type: "table", columns: [""], rows: [] }, { type: "fields", items: [] }])).blocks).toHaveLength(5);
  });

  it("keeps code/HTML-looking text literal data, not a special executable block", () => {
    const literal = '<script>alert("not executed")</script> javascript:alert(1)';
    expect(parse(minimal([{ type: "text", text: literal }])).blocks[0]).toEqual({ type: "text", text: literal });
  });

  it.each(["", " ", "\t\r\n", "\uFEFF"])("rejects a blank title %j", (title) => {
    expect(() => parse({ ...minimal(), title })).toThrow(PluginViewFault);
  });

  it.each(["id", "revision", "html", "css", "script", "className", "onClick", "url"])("rejects unsupported or host-owned field %s", (key) => {
    expect(() => parse({ ...minimal(), [key]: "untrusted" })).toThrow(PluginViewFault);
  });

  it.each([
    { type: "html", html: "<b>unsafe</b>" },
    { type: "text", text: "x", style: "color:red" },
    { type: "code", code: "x", text: "cross-variant" },
    { type: "fields", items: [{ label: "x", value: "y", editable: true }] },
    { type: "fields", items: [{ label: "x", value: "y", onChange: "run" }] },
    { type: "status", tone: "critical", text: "x" },
    { type: "status", tone: "INFO", text: "x" },
  ])("rejects arbitrary injection and unknown variants %j", (block) => {
    expect(() => parse(minimal([block]))).toThrow(PluginViewFault);
  });

  it("requires all declared definition and block fields", () => {
    for (const raw of [{ title: "x", blocks: [] }, { title: "x", actions: [] }, { blocks: [], actions: [] },
      minimal([{ type: "text" }]), minimal([{ type: "table", columns: ["x"] }]), minimal([{ type: "status", text: "x" }])]) {
      expect(() => parse(raw)).toThrow(PluginViewFault);
    }
  });
});

describe("control view JSON and string boundary", () => {
  it("rejects external objects without executing accessors, coercion, toJSON or Proxy traps", () => {
    const called = vi.fn(() => { throw Error("must not execute"); });
    const getter = Object.defineProperty({}, "title", { get: called });
    const proxy = new Proxy({}, { get: called, getPrototypeOf: called, ownKeys: called, getOwnPropertyDescriptor: called });
    for (const raw of [fixture(), getter, proxy, { toJSON: called }, { [Symbol.toPrimitive]: called }, new String(JSON.stringify(fixture())), null, 1]) {
      expect(() => parsePluginControlledView(raw)).toThrow(PluginViewFault);
    }
    expect(called).not.toHaveBeenCalled();
  });

  it.each(["", "null", "[]", "true", "{", '{"title":"x",}'])("rejects malformed/nonobject JSON %s", (raw) => {
    expect(() => parsePluginControlledView(raw)).toThrow(PluginViewFault);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects unsafe object key %s in both outer and action input data", (key) => {
    expect(() => parsePluginControlledView(`{"title":"x","blocks":[],"actions":[],"${key}":{}}`)).toThrow(PluginViewFault);
    const action = { id: "run", label: "运行", actionId: "run", inputJson: `{"nested":{"${key}":true}}` };
    expect(() => parse(minimal([], [action]))).toThrow(PluginViewFault);
  });

  it.each(["\u0000", "\u0008", "\u000b", "\u001b", "\u007f", "\u0085", "\ud800", "\udc00"])("rejects forbidden control or malformed surrogate %j", (bad) => {
    expect(() => parse({ ...minimal(), title: "title" + bad })).toThrow(PluginViewFault);
    expect(() => parse(minimal([{ type: "text", text: "text" + bad }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([], [{ id: "run", label: "运行", actionId: "run", inputJson: JSON.stringify({ value: bad }) }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([], [{ id: "run", label: "运行", actionId: "run", inputJson: JSON.stringify({ [bad]: "value" }) }]))).toThrow(PluginViewFault);
  });

  it("preserves ordinary multiline whitespace and well-formed Unicode", () => {
    const text = "黑塔 🌌\tline\r\nnext";
    expect(parse(minimal([{ type: "code", code: text, language: "c++" }])).blocks[0]).toEqual({ type: "code", code: text, language: "c++" });
  });

  it("enforces the whole definition's UTF-8 byte budget, including whitespace", () => {
    const json = JSON.stringify(fixture()), used = new TextEncoder().encode(json).length;
    const padded = json + " ".repeat(PLUGIN_VIEW_LIMITS.jsonBytes - used);
    expect(parsePluginControlledView(padded).title).toBe("观测结果 🌌");
    expect(() => parsePluginControlledView(padded + " ")).toThrow(PluginViewFault);
    expect(() => parse(minimal([{ type: "code", code: "字".repeat(16000) }, { type: "text", text: "字".repeat(500) }]))).toThrow(PluginViewFault);
  });

  it("does not echo supplied source or unknown property text in its errors", () => {
    try { parse({ ...minimal(), "PRIVATE-KEY": "private value" }); throw Error("accepted"); }
    catch (error) { expect(error).toBeInstanceOf(PluginViewFault); expect(String(error)).not.toContain("PRIVATE"); expect(String(error)).not.toContain("private value"); }
  });
});

describe("bounded blocks and action references", () => {
  it("enforces block and action counts", () => {
    expect(parse(minimal(Array.from({ length: 24 }, () => ({ type: "text", text: "" })))).blocks).toHaveLength(24);
    expect(() => parse(minimal(Array.from({ length: 25 }, () => ({ type: "text", text: "" }))))).toThrow(PluginViewFault);
    const actions = Array.from({ length: 8 }, (_, index) => ({ id: `button-${index}`, label: "打开", actionId: "run", inputJson: "{}" }));
    expect(parse(minimal([], actions)).actions).toHaveLength(8);
    expect(() => parse(minimal([], [...actions, { ...actions[0], id: "last" }]))).toThrow(PluginViewFault);
  });

  it("enforces text/code/status/field lengths without flattening valid content", () => {
    for (const [block, field, maximum] of [
      [{ type: "text", text: "" }, "text", 8000], [{ type: "code", code: "" }, "code", 16000],
      [{ type: "status", tone: "info", text: "" }, "text", 2000],
    ] as const) {
      expect(parse(minimal([{ ...block, [field]: "x".repeat(maximum) }])).blocks).toHaveLength(1);
      expect(() => parse(minimal([{ ...block, [field]: "x".repeat(maximum + 1) }]))).toThrow(PluginViewFault);
    }
    expect(() => parse({ ...minimal(), title: "x".repeat(121) })).toThrow(PluginViewFault);
    expect(() => parse(minimal([{ type: "fields", items: [{ label: "x".repeat(121), value: "" }] }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([{ type: "fields", items: [{ label: "x", value: "y".repeat(2001) }] }]))).toThrow(PluginViewFault);
  });

  it.each(["", "../typescript", "text/html", "ts class=x", "x<script>", "a".repeat(33)])("rejects non-token code language %s", (language) => {
    expect(() => parse(minimal([{ type: "code", code: "x", language }]))).toThrow(PluginViewFault);
  });

  it("bounds lists and read-only fields", () => {
    expect(parse(minimal([{ type: "list", items: Array(100).fill("") }])).blocks).toHaveLength(1);
    expect(() => parse(minimal([{ type: "list", items: Array(101).fill("") }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([{ type: "list", items: ["x".repeat(2001)] }]))).toThrow(PluginViewFault);
    expect(parse(minimal([{ type: "fields", items: Array.from({ length: 32 }, () => ({ label: "x", value: "" })) }])).blocks).toHaveLength(1);
    expect(() => parse(minimal([{ type: "fields", items: Array.from({ length: 33 }, () => ({ label: "x", value: "" })) }]))).toThrow(PluginViewFault);
  });

  it("requires a bounded rectangular table with at least one column", () => {
    expect(parse(minimal([{ type: "table", columns: Array(12).fill("c"), rows: Array.from({ length: 100 }, () => Array(12).fill("")) }])).blocks).toHaveLength(1);
    for (const table of [
      { type: "table", columns: [], rows: [] }, { type: "table", columns: Array(13).fill("c"), rows: [] },
      { type: "table", columns: ["c"], rows: Array.from({ length: 101 }, () => [""]) },
      { type: "table", columns: ["a", "b"], rows: [["only one"]] },
      { type: "table", columns: ["a"], rows: [["one", "two"]] },
      { type: "table", columns: ["a"], rows: [["x".repeat(2001)]] },
    ]) expect(() => parse(minimal([table]))).toThrow(PluginViewFault);
  });

  it("rejects duplicate button IDs and invalid declarations without resolving their target manifest", () => {
    const action = { id: "same", label: "运行", actionId: "not-declared-here", inputJson: "{}" };
    expect(parse(minimal([], [action])).actions[0]?.actionId).toBe("not-declared-here");
    expect(() => parse(minimal([], [action, action]))).toThrow(PluginViewFault);
    for (const invalid of ["UPPER", "a:b", "a_b", "../run", "constructor", "prototype", "__proto__", "a".repeat(65)]) {
      expect(() => parse(minimal([], [{ ...action, id: invalid }]))).toThrow(PluginViewFault);
      expect(() => parse(minimal([], [{ ...action, actionId: invalid }]))).toThrow(PluginViewFault);
    }
    expect(() => parse(minimal([], [{ ...action, label: " " }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([], [{ ...action, label: "x".repeat(121) }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([], [{ ...action, runId: "forged" }]))).toThrow(PluginViewFault);
  });

  it.each(["[]", "null", "true", "42", '"text"', "{bad", 1, {}])("requires inputJson to encode an object: %j", (inputJson) => {
    expect(() => parse(minimal([], [{ id: "open", label: "打开", actionId: "run", inputJson }]))).toThrow(PluginViewFault);
  });

  it("bounds and normalizes action JSON by UTF-8 bytes", () => {
    const overhead = JSON.stringify({ value: "" }).length;
    const inputJson = JSON.stringify({ value: "x".repeat(PLUGIN_VIEW_LIMITS.actionInputBytes - overhead) });
    const action = { id: "open", label: "打开", actionId: "run", inputJson };
    expect(parse(minimal([], [action])).actions[0]?.inputJson).toBe(inputJson);
    expect(() => parse(minimal([], [{ ...action, inputJson: inputJson + " " }]))).toThrow(PluginViewFault);
    expect(() => parse(minimal([], [{ ...action, inputJson: JSON.stringify({ value: "字".repeat(12000) }) }]))).toThrow(PluginViewFault);
  });
});
