// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { auditChatImages } from "./chat-image-audit.js";
import { createChatImageQuarantine } from "./chat-image-quarantine.js";
const doc = (names: string[]) => JSON.stringify({schemaVersion:3,chats:[{messages:[{attachments:names.map(sha256=>({image:{storage:"sha256",sha256,mimeType:"image/png"}}))}]}]});
function fixture() {
  const p=join(mkdtempSync(join(tmpdir(),"herta-quarantine-")),"chat.json");mkdirSync(`${p}.images`);
  const add=(text:string)=>{const bytes=Buffer.from(text),name=createHash("sha256").update(bytes).digest("hex");writeFileSync(join(`${p}.images`,name),bytes);return name;};
  const [current,backup,loose1,loose2]=["current","backup","loose-one","loose-two"].map(add) as [string,string,string,string];
  writeFileSync(p,doc([current]));writeFileSync(`${p}.v2-backup-x`,doc([backup]));
  return {p,current,backup,loose1,loose2,library:`${p}.images`};
}
it("isolates only unreferenced images, keeps backup-only images, and leaves the audit complete",()=>{
  const f=fixture(),q=createChatImageQuarantine(f.p),preview=q.preview();
  expect(preview).toMatchObject({files:2,bytes:18});expect(readdirSync(f.library)).toHaveLength(4);
  const moved=q.isolate(preview.token);expect(moved).toMatchObject({files:2,bytes:18,skipped:0});
  expect(readdirSync(f.library).sort()).toEqual([f.current,f.backup].sort());
  const dir=join(`${f.p}.images-quarantine`,moved.id!);expect(readdirSync(dir).sort()).toEqual([f.loose1,f.loose2,"manifest.json"].sort());
  expect(JSON.parse(readFileSync(join(dir,"manifest.json"),"utf8")).files).toHaveLength(2);
  expect(auditChatImages(f.p)).toMatchObject({complete:true,current:1,backupOnly:1,unreferenced:0});
  expect(q.batches()).toEqual([expect.objectContaining({id:moved.id,files:2,bytes:18})]);
  expect(q.preview()).toEqual({files:0,bytes:0});
});
it("re-checks references before moving and rejects stale or forged previews",()=>{
  const f=fixture(),q=createChatImageQuarantine(f.p),preview=q.preview();
  writeFileSync(f.p,doc([f.current,f.loose1]));
  expect(q.isolate(preview.token)).toMatchObject({files:1,skipped:1});expect(existsSync(join(f.library,f.loose1))).toBe(true);
  expect(()=>q.isolate(preview.token)).toThrow("过期");expect(()=>q.isolate("forged")).toThrow("过期");
});
it("refuses to clean when any record cannot be inspected",()=>{
  const f=fixture();writeFileSync(`${f.p}.v2-backup-broken`,"not json");
  expect(()=>createChatImageQuarantine(f.p).preview()).toThrow("无法检查");expect(readdirSync(f.library)).toHaveLength(4);
});
it("restores verified files, deduplicates re-added images, keeps tampered ones and respects the limit",()=>{
  const f=fixture(),q=createChatImageQuarantine(f.p),moved=q.isolate(q.preview().token),dir=join(`${f.p}.images-quarantine`,moved.id!);
  writeFileSync(join(f.library,f.loose1),"loose-one");
  expect(()=>createChatImageQuarantine(f.p,20).restore(moved.id)).toThrow("256 MB");expect(readdirSync(dir)).toHaveLength(3);
  expect(q.restore(moved.id)).toEqual({restored:1,duplicates:1,rejected:0});expect(existsSync(dir)).toBe(false);expect(readdirSync(f.library)).toHaveLength(4);
  const again=q.isolate(q.preview().token),dir2=join(`${f.p}.images-quarantine`,again.id!);writeFileSync(join(dir2,f.loose2),"tampered");
  expect(q.restore(again.id)).toEqual({restored:1,duplicates:0,rejected:1});expect(readdirSync(dir2)).toContain(f.loose2);
});
it("discards one confirmed batch and never accepts a path outside the quarantine",()=>{
  const f=fixture(),q=createChatImageQuarantine(f.p),moved=q.isolate(q.preview().token);
  for(const id of ["../chat.json.images","20261020T000000-zzzzzzzz",undefined,"20261020T000000-0000000"])expect(()=>q.discard(id)).toThrow("隔离批次");
  expect(q.discard(moved.id)).toEqual({files:2,bytes:18});expect(q.batches()).toEqual([]);expect(readdirSync(f.library)).toHaveLength(2);
});
it.each(["corrupt-file", "directory"])("keeps the verified quarantined image when the destination is a %s", (kind) => {
  const f = fixture(), q = createChatImageQuarantine(f.p);
  const moved = q.isolate(q.preview().token);
  const destination = join(f.library, f.loose1);
  if (kind === "directory") mkdirSync(destination);
  else writeFileSync(destination, "truncated");
  const saved = join(`${f.p}.images-quarantine`, moved.id!, f.loose1);
  expect(q.restore(moved.id)).toEqual({ restored: 1, duplicates: 0, rejected: 1 });
  expect(readFileSync(saved, "utf8")).toBe("loose-one");
  expect(existsSync(destination)).toBe(true);
});
