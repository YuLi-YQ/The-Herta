// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { auditChatImages } from "./chat-image-audit.js";
const doc = (images: unknown[], schemaVersion = 3) => JSON.stringify({schemaVersion, chats:[{messages:[{attachments:images.map(image=>({image}))}]}]});
const ref = (sha256: string) => ({storage:"sha256",sha256,mimeType:"image/png"});
function fixture() { const file=join(mkdtempSync(join(tmpdir(),"herta-audit-")),"chat.json"); mkdirSync(`${file}.images`); return file; }
it("protects current, archived and embedded-backup references without altering files",()=>{
  const p=fixture(),a="a".repeat(64),c="c".repeat(64),d="d".repeat(64);
  const bytes=Buffer.from("legacy-image"),b=createHash("sha256").update(bytes).digest("hex");
  const original=doc([ref(a),ref(d)]);writeFileSync(p,original);
  writeFileSync(`${p}.v2-backup-example`,doc([{data:bytes.toString("base64"),mimeType:"image/png"}],2));
  for(const name of [a,b,c]) writeFileSync(join(`${p}.images`,name),"bytes");
  expect(auditChatImages(p)).toEqual({complete:true,current:1,backupOnly:1,unreferenced:1,unreferencedBytes:5,missing:1,checkedBackups:1});
  expect(readFileSync(p,"utf8")).toBe(original);expect(readdirSync(`${p}.images`)).toHaveLength(3);
});
it("marks unknown or unreadable backups incomplete instead of declaring images removable",()=>{
  const p=fixture();writeFileSync(p,doc([]));writeFileSync(`${p}.v2-backup-broken`,"not json");
  expect(auditChatImages(p).complete).toBe(false);
  writeFileSync(`${p}.v2-backup-broken`,doc([]));writeFileSync(`${p}.bak`,"unknown");
  expect(auditChatImages(p).complete).toBe(false);
});
it("does not report embedded legacy images as missing external blobs",()=>{
  const p=fixture();writeFileSync(p,doc([{data:Buffer.from("legacy").toString("base64"),mimeType:"image/png"}],2));
  expect(auditChatImages(p)).toMatchObject({complete:true,missing:0});
});

