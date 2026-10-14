// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatImageStore } from "./chat-image-store.js";
const image={mimeType:"image/png" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
const store=()=>({schemaVersion:2,chats:[{messages:[{attachments:[{name:"x.png",text:"",image},{name:"same.png",text:"",image:{...image}}]}]}]});
it("stores one binary copy, keeps JSON compact and restores exact image bytes",()=>{
 const dir=join(mkdtempSync(join(tmpdir(),"herta-images-")),"images"), codec=createChatImageStore(dir);
 const serialized=codec.serialize(store());
 expect(serialized).not.toContain(image.data);expect(JSON.parse(serialized).schemaVersion).toBe(3);
 expect(readdirSync(dir)).toHaveLength(1);
 expect(readFileSync(join(dir,readdirSync(dir)[0]!)).toString("base64")).toBe(image.data);
 expect(codec.hydrate(JSON.parse(serialized))).toEqual(store());
});
it("keeps text readable and references recoverable when an image is corrupt",()=>{
 const dir=join(mkdtempSync(join(tmpdir(),"herta-images-")),"images"), codec=createChatImageStore(dir), serialized=codec.serialize(store());
 const file=join(dir,readdirSync(dir)[0]!);writeFileSync(file,"corrupt");
 const partial=codec.hydrate(JSON.parse(serialized)) as ReturnType<typeof store>;
 expect(partial.chats[0]!.messages[0]!.attachments[0]).toMatchObject({name:"x.png",imageMissing:true});
 expect(codec.serialize(partial)).toBe(serialized);
 writeFileSync(file,Buffer.from(image.data,"base64"));
 expect(codec.hydrate(JSON.parse(serialized))).toEqual(store());
});
it("refuses references with paths and refuses to overwrite damaged existing blobs",()=>{
 const dir=join(mkdtempSync(join(tmpdir(),"herta-images-")),"images"), codec=createChatImageStore(dir);
 expect(()=>codec.hydrate({attachments:[{image:{storage:"sha256",sha256:"../private",mimeType:"image/png"}}]})).toThrow();
 codec.serialize(store());const file=join(dir,readdirSync(dir)[0]!);writeFileSync(file,"corrupt");
 expect(()=>createChatImageStore(dir).serialize(store())).toThrow();
 expect(readFileSync(file,"utf8")).toBe("corrupt");
});
it("reports deduplicated on-disk usage without creating an empty directory",()=>{
 const dir=join(mkdtempSync(join(tmpdir(),"herta-usage-")),"images"), codec=createChatImageStore(dir);
 expect(codec.usage()).toEqual({bytes:0,files:0,limitBytes:256*1024*1024});
 expect(()=>readdirSync(dir)).toThrow();
 codec.serialize(store());
 const before=readdirSync(dir);
 expect(codec.usage()).toEqual({bytes:Buffer.from(image.data,"base64").length,files:1,limitBytes:256*1024*1024});
 writeFileSync(join(dir,"retained.tmp"),"abc");
 expect(codec.usage().bytes).toBe(Buffer.from(image.data,"base64").length+3);
 expect(codec.usage().files).toBe(1);
 expect(readdirSync(dir)).toHaveLength(before.length+1);
});
it("defers binary validation until preview and preserves exact references when saving",()=>{
 const dir=join(mkdtempSync(join(tmpdir(),"herta-deferred-")),"images"),codec=createChatImageStore(dir);
 const serialized=codec.serialize(store());
 const file=join(dir,readdirSync(dir)[0]!);writeFileSync(file,"corrupt");
 const lazy=codec.hydrate(JSON.parse(serialized),true) as {chats:{messages:{attachments:{imageRef:unknown}[]}[]}[]};
 expect(JSON.stringify(lazy)).not.toContain(image.data);
 expect(codec.serialize(lazy)).toBe(serialized);
 expect(()=>codec.readImage(lazy.chats[0]!.messages[0]!.attachments[0]!.imageRef)).toThrow();
 writeFileSync(file,Buffer.from(image.data,"base64"));
 expect(codec.readImage(lazy.chats[0]!.messages[0]!.attachments[0]!.imageRef)).toEqual(image);
});
