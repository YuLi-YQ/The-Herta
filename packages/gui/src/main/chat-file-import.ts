import { sniffImage } from "@herta/app-server/image";
import {
  extractDocumentText,
  sniffDocumentFormat,
} from "@herta/app-server/document-text";
import {
  validateChatAttachments,
  type ChatFileResult,
} from "../shared/herta-chat.js";
const fail = (message: string): ChatFileResult => ({ ok: false, message });
/** Accept uploaded bytes only, never a renderer-provided local path. No file writes or network. */
export async function parseChatFile(
  name: unknown,
  data: unknown,
): Promise<ChatFileResult> {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 180 ||
    /[\\/\x00-\x1f]/.test(name)
  )
    return fail("附件名称无效。");
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer))
    return fail("附件数据无效。");
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > 4 * 1024 * 1024) return fail("单个附件不能超过4 MB。");
  try {
    const ext = name.toLowerCase().split(".").at(-1);
    if (["png", "jpg", "jpeg"].includes(ext ?? "")) {
      const info = sniffImage(Buffer.from(bytes));
      if (!info || !["png", "jpeg"].includes(info.format) || (ext === "png") !== (info.format === "png")) return fail("图片格式不匹配。");
      if (!info.width || !info.height || info.width > 4096 || info.height > 4096) return fail("图片边长不能超过4096像素，且必须有有效尺寸。");
      if (bytes.byteLength > 2 * 1024 * 1024) return fail("图片不能超过2 MB。");
      const { nativeImage } = await import("electron");
      if (nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty()) return fail("图片无法解码，可能已经损坏。");
      return { ok: true, attachment: validateChatAttachments([{ name, text: "", image: { mimeType: `image/${info.format}`, data: Buffer.from(bytes).toString("base64") } }])[0]! };
    }
    if (ext === "pdf" || ext === "docx") {
      const sniff = sniffDocumentFormat(name, bytes);
      if (sniff.kind !== ext)
        return fail(
          "文档格式不匹配或已加密，请导出为普通 PDF 或 DOCX 后再添加。",
        );
      const result = await extractDocumentText(ext, bytes.slice(), {
        maxPages: 100,
        pictures: false,
        lang: "zh",
      });
      if (!result.ok)
        return fail(
          {
            empty: "文档没有可读取的文字。扫描件暂不支持 OCR，请先转换为文字。",
            encrypted: "文档已加密，请解密后再添加。",
            too_many_pages: "PDF 不能超过100页，请选取需要的章节。",
            unsupported: "文档格式不受支持，请导出为普通 PDF 或 DOCX。",
            parse_error: "文档未能解析，可能损坏或内容过大。",
          }[result.reason],
        );
      if (result.text.length > 32000)
        return fail("提取文字超过32000字，请选取需要的章节；未截断上传。");
      const attachment = validateChatAttachments([
        {
          name,
          text: result.text,
          format: ext,
          ...(result.pages ? { pages: result.pages } : {}),
        },
      ])[0]!;
      return { ok: true, attachment };
    }
    if (
      !/^(txt|md|csv|json|xml|yaml|yml|html|css|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|sql|log)$/.test(
        ext ?? "",
      )
    )
      return fail(
        "支持文本、代码、PDF、DOCX、PNG 和 JPEG；旧版 Office 暂不支持。",
      );
    if (bytes.byteLength > 128000) return fail("文本文件不能超过128 KB。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 32000 || text.includes("\u0000"))
      return fail("文本必须为有效 UTF-8，且不超过32000字。");
    return {
      ok: true,
      attachment: validateChatAttachments([{ name, text }])[0]!,
    };
  } catch {
    return fail("文件未能读取，请检查编码、格式或文件是否损坏。");
  }
}
