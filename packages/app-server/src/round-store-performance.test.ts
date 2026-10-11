import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const counters = vi.hoisted(()=>({root:"", reads:0, bytes:0}));
vi.mock("node:fs", async importOriginal=>{
 const actual=await importOriginal<typeof import("node:fs")>();
 return {...actual,readFileSync:(...args: Parameters<typeof readFileSync>)=>{
  const value=actual.readFileSync(...args);
  if(counters.root && String(args[0]).startsWith(counters.root)) {counters.reads++;counters.bytes+=Buffer.byteLength(value);}
  return value;
 }};
});
import { RoundStore, lineCounts } from "./round-store.js";
const roots:string[]=[];
afterEach(()=>{counters.root="";for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(count:number){
 const root=mkdtempSync(join(tmpdir(),"herta-scan-cache-"));roots.push(root);
 const workspace=join(root,"workspace");mkdirSync(workspace);
 for(let i=0;i<count;i++)writeFileSync(join(workspace,`file-${i}.ts`),"// fixture\n".repeat(700));
 counters.root=workspace;counters.reads=0;counters.bytes=0;
 return {workspace,store:new RoundStore(join(root,"history.json"),"s",()=>workspace)};
}
function start(store:RoundStore,id:string){store.event({type:"tool.call.started",layer:"backend",id,tool:"edit_file",inputSummary:"fixture",input:{}});}
function finish(store:RoundStore,id:string){store.event({type:"tool.call.finished",layer:"backend",id,tool:"edit_file",result:{ok:true,summary:"fixture"}});}
it("reuses 500 unchanged snapshots and invalidates one same-size file even after restoring mtime",()=>{
 const {workspace,store}=setup(500);
 const t=performance.now();store.begin("a",0);const coldMs=performance.now()-t;
 expect(counters.reads).toBe(500);const coldBytes=counters.bytes;
 counters.reads=0;counters.bytes=0;const warm=performance.now();
 start(store,"one");finish(store,"one");
 const warmPairMs=performance.now()-warm;expect(counters.reads).toBe(0);
 const path=join(workspace,"file-1.ts"),before=statSync(path);
 start(store,"edit");writeFileSync(path,"// changed\n".repeat(700));utimesSync(path,before.atime,before.mtime);finish(store,"edit");
 expect(counters.reads).toBe(1);
 const round=store.summaries()[0]!;expect(round.activities[1]!.files).toHaveLength(1);
 expect(store.read(round.id,round.activities[1]!.files[0]!.fileId)?.after).toContain("changed");
 console.log(JSON.stringify({fixtureFiles:500,coldContentReads:500,coldBytes,warmPairContentReads:0,changedContentReads:1,coldMs,warmPairMs}));
});
it("detects deletion and recreation and resets the cache between rounds",()=>{
 const {workspace,store}=setup(1);store.begin("a",0);start(store,"delete");
 rmSync(join(workspace,"file-0.ts"));finish(store,"delete");
 expect(store.summaries()[0]!.activities[0]!.files).toHaveLength(1);
 writeFileSync(join(workspace,"file-0.ts"),"recreated");store.finish("completed");
 counters.reads=0;store.begin("b",0);expect(counters.reads).toBe(1);
});
it("keeps unchanged long prefixes linear and preserves exact net counts",()=>{
 const prefix="same\n".repeat(50000);
 expect(lineCounts(prefix+"old\n",prefix+"new\n")).toEqual({added:1,removed:1});
 expect(lineCounts(prefix,prefix)).toEqual({added:0,removed:0});
});
it("keeps scan limits explicit and never turns an omitted file into a deletion",()=>{
 const {store}=setup(2050);store.begin("a",0);store.finish("completed");
 const round=store.summaries()[0]!;
 expect(round.limitations.join(" ")).toContain("2000");
 expect(round.files).toHaveLength(0);
 expect(counters.reads).toBeLessThanOrEqual(2000);
});
