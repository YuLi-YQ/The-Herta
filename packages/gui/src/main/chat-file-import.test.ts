// @vitest-environment node
import { it, expect, vi } from "vitest";
import { createChatFileReader, parseChatFile } from "./chat-file-import.js";
import {
  makePdf,
  makeDocx,
  docxParagraphs,
} from "../../../app-server/dist/testing/document-fixtures.js";
import { validateChatAttachments } from "../shared/herta-chat.js";
it("extracts PDF text with page evidence and preserves attachment metadata", async () => {
  const result = await parseChatFile(
    "report.pdf",
    makePdf([["Hello PDF"], ["Second page"]]),
  );
  expect(result).toMatchObject({
    ok: true,
    attachment: { name: "report.pdf", format: "pdf", pages: 2 },
  });
  if (result.ok) {
    expect(result.attachment.text).toContain("Hello PDF");
    expect(validateChatAttachments([result.attachment])[0]).toEqual(
      result.attachment,
    );
  }
});
it("extracts DOCX paragraphs without claiming image understanding", async () => {
  const result = await parseChatFile(
    "中文.docx",
    makeDocx(docxParagraphs(["你好黑塔", "Second paragraph"])),
  );
  expect(result).toMatchObject({ ok: true, attachment: { format: "docx" } });
  if (result.ok) expect(result.attachment.text).toContain("你好黑塔");
});
it("rejects scanned, oversized, malformed and encrypted documents", async () => {
  expect(await parseChatFile("scan.pdf", makePdf([[]]))).toMatchObject({
    ok: false,
    message: expect.stringContaining("OCR"),
  });
  expect(
    await parseChatFile(
      "large.pdf",
      makePdf(Array.from({ length: 101 }, () => ["x"])),
    ),
  ).toMatchObject({ ok: false, message: expect.stringContaining("100页") });
  expect(
    await parseChatFile("fake.pdf", new TextEncoder().encode("not pdf")),
  ).toMatchObject({ ok: false });
  expect(
    await parseChatFile(
      "large.docx",
      makeDocx(docxParagraphs(["x".repeat(33000)])),
    ),
  ).toMatchObject({ ok: false, message: expect.stringContaining("未截断") });
  expect(
    await parseChatFile(
      "bomb.docx",
      makeDocx(docxParagraphs(["x".repeat(9 * 1024 * 1024)])),
    ),
  ).toMatchObject({ ok: false });
});
it("accepts uploaded UTF8 bytes and rejects paths, binaries, names and excess bytes", async () => {
  expect(
    await parseChatFile("notes.md", new TextEncoder().encode("中文")),
  ).toMatchObject({ ok: true, attachment: { text: "中文" } });
  for (const [name, data] of [
    ["notes.txt", "C:/private.txt"],
    ["../notes.txt", new Uint8Array()],
    ["x.exe", new Uint8Array()],
    ["x.txt", new Uint8Array([255])],
    ["x.pdf", new Uint8Array(4 * 1024 * 1024 + 1)],
  ])
    expect(await parseChatFile(name, data)).toMatchObject({ ok: false });
});


vi.mock("electron",()=>({nativeImage:{createFromBuffer:()=>({isEmpty:()=>false})}}));
const prepare=vi.hoisted(()=>vi.fn());
vi.mock("./prepare-image.js",()=>({prepareAttachedImage:prepare}));
it("imports bounded PNG bytes and rejects oversized dimensions and fake extensions",async()=>{
 const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
 expect(await parseChatFile("x.png",bytes)).toMatchObject({ok:true,attachment:{text:"",image:{mimeType:"image/png"}}});
 expect(await parseChatFile("x.jpg",bytes)).toMatchObject({ok:false});
 const huge=Buffer.from(bytes);huge.writeUInt32BE(20000,16);
 expect(await parseChatFile("huge.png",huge)).toMatchObject({ok:false,message:expect.stringContaining("16384")});
 huge.writeUInt32BE(1,16);huge.writeUInt32BE(20000,20);
 expect(await parseChatFile("tall.png",huge)).toMatchObject({ok:false,message:expect.stringContaining("16384")});
 expect(()=>validateChatAttachments([{name:"x.png",text:"injected",image:{mimeType:"image/png",data:bytes.toString("base64")}}])).toThrow();
});
it("rescales a chat picture over 2 MB or 4096 px instead of refusing it, like the workbench (R82)",async()=>{
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
 const small={mimeType:"image/jpeg" as const,data:Buffer.from([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]).toString("base64")};
 // Wide (5120 px) but small in bytes: rescaled, and a PNG that became JPEG is named .jpg.
 const wide=Buffer.from(png);wide.writeUInt32BE(5120,16);
 prepare.mockResolvedValueOnce(small);
 expect(await parseChatFile("ultrawide.png",wide)).toMatchObject({ok:true,attachment:{name:"ultrawide.jpg",text:"",image:{mimeType:"image/jpeg"}}});
 expect(prepare).toHaveBeenCalledTimes(1);
 // Over 2 MB within the 8 MB picture cap: rescaled; a rescale that cannot fit fails plainly.
 const heavy=Buffer.concat([png,Buffer.alloc(3*1024*1024)]);
 prepare.mockResolvedValueOnce({mimeType:"image/png",data:png.toString("base64")});
 expect(await parseChatFile("heavy.png",heavy)).toMatchObject({ok:true,attachment:{name:"heavy.png",image:{mimeType:"image/png"}}});
 prepare.mockResolvedValueOnce(null);
 expect(await parseChatFile("heavy.png",heavy)).toEqual({ok:false,message:"图片无法解码，或缩小后仍超过2 MB。"});
 // Small pictures are kept as they are; caps: 8 MB for pictures, 4 MB for other files.
 prepare.mockClear();
 expect(await parseChatFile("x.png",png)).toMatchObject({ok:true,attachment:{image:{mimeType:"image/png",data:png.toString("base64")}}});
 expect(prepare).not.toHaveBeenCalled();
 expect(await parseChatFile("big.png",Buffer.concat([png,Buffer.alloc(9*1024*1024)]))).toEqual({ok:false,message:"图片不能超过8 MB。"});
 expect(await parseChatFile("big.txt",Buffer.alloc(5*1024*1024,97))).toEqual({ok:false,message:"单个附件不能超过4 MB。"});
});
it("stops a cancelled read: before it starts, while a PDF opens, and for text (R118)", async () => {
  const before = new AbortController();
  before.abort();
  expect(await parseChatFile("a.pdf", makePdf([["x"]]), before.signal)).toEqual(
    { ok: false, message: "附件读取已取消。" },
  );
  expect(
    await parseChatFile("a.md", new TextEncoder().encode("# x"), before.signal),
  ).toEqual({ ok: false, message: "附件读取已取消。" });
  const between = new AbortController();
  const pages = Array.from({ length: 40 }, (_, i) => [`page ${i + 1}`]);
  const running = parseChatFile("long.pdf", makePdf(pages), between.signal);
  between.abort();
  expect(await running).toEqual({ ok: false, message: "附件读取已取消。" });
  // An unaborted signal reads as before.
  expect(
    await parseChatFile(
      "a.md",
      new TextEncoder().encode("# x"),
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true });
});
it("reads one chat file at a time and cancels only the job being read (R118)", async () => {
  let release: (() => void) | undefined;
  let seen: AbortSignal | undefined;
  const reader = createChatFileReader(async (_name, _data, signal) => {
    seen = signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, attachment: { name: "a.md", text: "x" } };
  });
  const first = reader.parse("a.md", new Uint8Array(1), "file-1-a");
  expect(await reader.parse("b.md", new Uint8Array(1), "file-2-b")).toEqual({
    ok: false,
    message: "请等待当前附件解析完成。",
  });
  expect(reader.cancel("file-2-b")).toBe(false);
  expect(reader.cancel({ job: "file-1-a" })).toBe(false);
  expect(reader.cancel("file-1-a/../x")).toBe(false);
  expect(seen?.aborted).toBe(false);
  expect(reader.cancel("file-1-a")).toBe(true);
  expect(seen?.aborted).toBe(true);
  release?.();
  await first;
  // The lock is free again, and a finished job cannot be cancelled.
  expect(reader.cancel("file-1-a")).toBe(false);
  const next = reader.parse("c.md", new Uint8Array(1));
  release?.();
  expect(await next).toMatchObject({ ok: true });
});
