import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoundStore } from "./round-store.js";
const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "herta-round-test-"));
  dirs.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const path = join(root, "history", "rounds.json");
  return { workspace, path, store: new RoundStore(path, "s", () => workspace) };
}
it("records new files when an isolated workspace does not exist at round start", () => {
  const { workspace, store } = setup();
  rmSync(workspace, { recursive: true });
  store.begin("first", 0);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "hello.ts"), "export const hello = 1;\n");
  store.finish("failed");
  const round = store.summaries()[0]!;
  expect(round.files).toHaveLength(1);
  expect(round.files[0]).toMatchObject({ path: "hello.ts", kind: "added", added: 1 });
  expect(round.limitations).not.toContain("部分目录不可读，扫描不完整");
});
it("freezes step and net snapshots across edits, failure and reload", () => {
  const { workspace, path, store } = setup();
  writeFileSync(join(workspace, "a.ts"), "const a = 1;\n");
  store.begin("a1", 0);
  for (const [id, value] of [
    ["t1", 2],
    ["t2", 3],
  ] as const) {
    store.event({
      type: "tool.call.started",
      layer: "backend",
      id,
      tool: "edit_file",
      inputSummary: "edit a.ts",
      input: { path: "a.ts" },
    });
    writeFileSync(join(workspace, "a.ts"), `const a = ${value};\n`);
    store.event({
      type: "tool.call.finished",
      layer: "backend",
      id,
      tool: "edit_file",
      result: { ok: true, summary: "edited" },
    });
  }
  store.finish("failed");
  const round = store.summaries()[0]!;
  expect(round.status).toBe("failed");
  expect(round.files[0]).toMatchObject({ added: 1, removed: 1 });
  expect(
    store.read(round.id, round.activities[0]!.files[0]!.fileId)?.after,
  ).toContain("= 2");
  writeFileSync(join(workspace, "a.ts"), "later external edit");
  const reloaded = new RoundStore(path, "s", () => workspace);
  expect(reloaded.read(round.id, round.files[0]!.id)).toMatchObject({
    before: "const a = 1;\n",
    after: "const a = 3;\n",
  });
  expect(reloaded.read(round.id, "../a.ts")).toBeNull();
});
it("does not duplicate a finished call, distinguishes stderr from failure, and resumes a logical round", () => {
  const { store } = setup();
  store.begin("a1", 0);
  const finished = {
    type: "tool.call.finished",
    layer: "backend",
    id: "c",
    tool: "command",
    result: {
      ok: true,
      summary: "ok",
      data: { exitCode: 0, stderr: "diagnostic" },
    },
  } as const;
  store.event(finished);
  store.event(finished);
  store.finish("waiting");
  store.begin("a2", 4, true);
  store.finish("completed");
  expect(store.summaries()).toHaveLength(1);
  expect(store.summaries()[0]!.attemptIds).toEqual(["a1", "a2"]);
  expect(store.summaries()[0]!.activities).toHaveLength(1);
  expect(store.summaries()[0]!.activities[0]!.status).toBe("succeeded");
});
it("preserves interrupted calls as unknown and excludes credential files", () => {
  const { workspace, path, store } = setup();
  store.begin("a", 0);
  store.event({
    type: "tool.call.started",
    layer: "backend",
    id: "c",
    tool: "command",
    inputSummary: "working",
  });
  writeFileSync(join(workspace, ".env"), "API_KEY=private");
  const reloaded = new RoundStore(path, "s", () => workspace);
  expect(reloaded.summaries()[0]!.status).toBe("interrupted");
  expect(reloaded.summaries()[0]!.activities[0]!.status).toBe("unknown");
  store.finish("cancelled");
  expect(store.summaries()[0]!.files).toHaveLength(0);
});
it("preserves separate search hits, deduplicates repeated hits and freezes line contents", () => {
 const {workspace,path,store}=setup();
 writeFileSync(join(workspace,"hits.ts"),"one\nmatch two\nmatch three\n");
 store.begin("a",0);
 store.event({type:"tool.call.started",layer:"backend",id:"search",tool:"search_text",inputSummary:"match",input:{query:"match"}});
 store.event({type:"tool.call.finished",layer:"backend",id:"search",tool:"search_text",result:{ok:true,summary:"found",data:{matches:[{path:"hits.ts",line:2,content:"match two"},{path:"hits.ts",line:3,content:"match three"},{path:"hits.ts",line:2,content:"match two"}]}}});
 store.finish("completed");
 writeFileSync(join(workspace,"hits.ts"),"later contents");
 const reloaded=new RoundStore(path,"s",()=>workspace);
 const round=reloaded.summaries()[0]!;
 expect(round.activities[0]!.files.map(f=>f.line)).toEqual([2,3]);
 expect(reloaded.read(round.id,round.activities[0]!.files[1]!.fileId)?.after).toContain("match three");
});
it("does not offer precise navigation when a search result disagrees with the saved file",()=>{
 const {workspace,store}=setup();
 writeFileSync(join(workspace,"a.ts"),"changed");store.begin("a",0);
 store.event({type:"tool.call.finished",layer:"backend",id:"s",tool:"search_text",result:{ok:true,summary:"found",data:{matches:[{path:"a.ts",line:1,content:"old text"}]}}});
 const round=store.summaries()[0]!;
 expect(round.activities[0]!.files[0]!.line).toBeUndefined();
 expect(round.limitations.join(" ")).toContain("未提供精确行定位");
});
