// @vitest-environment node
import { it, expect, vi } from "vitest";
import { parseChatFile } from "./chat-file-import.js";
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
it("imports bounded PNG bytes and rejects oversized dimensions and fake extensions",async()=>{
 const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
 expect(await parseChatFile("x.png",bytes)).toMatchObject({ok:true,attachment:{text:"",image:{mimeType:"image/png"}}});
 expect(await parseChatFile("x.jpg",bytes)).toMatchObject({ok:false});
 const huge=Buffer.from(bytes);huge.writeUInt32BE(5000,16);
 expect(await parseChatFile("huge.png",huge)).toMatchObject({ok:false,message:expect.stringContaining("4096")});
 expect(()=>validateChatAttachments([{name:"x.png",text:"injected",image:{mimeType:"image/png",data:bytes.toString("base64")}}])).toThrow();
});
