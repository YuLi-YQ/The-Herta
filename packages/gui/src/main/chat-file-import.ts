import { sniffImage } from "@herta/app-server/image";
import {
  extractDocumentText,
  sniffDocumentFormat,
} from "@herta/app-server/document-text";
import {
  validateChatAttachments,
  type ChatFileResult,
} from "../shared/herta-chat.js";
import { prepareAttachedImage } from "./prepare-image.js";
const fail = (message: string): ChatFileResult => ({ ok: false, message });
/** The renderer drops a cancelled card's result unread; the words are for a log or a test. */
const CANCELLED = "附件读取已取消。";
/** Accept uploaded bytes only, never a renderer-provided local path. No file writes or network.
 *  `signal` stops the read (R118): checked between steps, and a PDF between pages. Decoding or
 *  rescaling a picture, a Word file and a text file each run as one synchronous step that a
 *  cancel cannot interrupt; their result is then dropped. */
export async function parseChatFile(
  name: unknown,
  data: unknown,
  signal?: AbortSignal,
): Promise<ChatFileResult> {
  const result = await readChatFile(name, data, signal);
  return signal?.aborted === true ? fail(CANCELLED) : result;
}

async function readChatFile(
  name: unknown,
  data: unknown,
  signal: AbortSignal | undefined,
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
  const ext = name.toLowerCase().split(".").at(-1);
  const picture = ["png", "jpg", "jpeg"].includes(ext ?? "");
  // A picture may be larger since it is rescaled below (a 4K screenshot is often over 4 MB).
  if (bytes.byteLength > (picture ? 8 : 4) * 1024 * 1024)
    return fail(picture ? "图片不能超过8 MB。" : "单个附件不能超过4 MB。");
  try {
    if (picture) {
      const info = sniffImage(Buffer.from(bytes));
      if (!info || !["png", "jpeg"].includes(info.format) || (ext === "png") !== (info.format === "png")) return fail("图片格式不匹配。");
      if (!info.width || !info.height || info.width > 16384 || info.height > 16384) return fail("图片边长不能超过16384像素，且必须有有效尺寸。");
      if (signal?.aborted === true) return fail(CANCELLED);
      // R82: like the workbench (R77), a picture over 2 MB or 4096 px is rescaled (longest side
      // 2048, PNG when it fits, else JPEG) instead of refused; only one that still does not fit fails.
      if (bytes.byteLength > 2 * 1024 * 1024 || info.width > 4096 || info.height > 4096) {
        const rescaled = await prepareAttachedImage(Buffer.from(bytes));
        if (!rescaled) return fail("图片无法解码，或缩小后仍超过2 MB。");
        const shown = rescaled.mimeType === "image/jpeg" && ext === "png" ? name.replace(/\.png$/i, ".jpg") : name;
        return { ok: true, attachment: validateChatAttachments([{ name: shown, text: "", image: rescaled }])[0]! };
      }
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
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!result.ok)
        return fail(
          {
            empty: "文档没有可读取的文字。扫描件暂不支持 OCR，请先转换为文字。",
            encrypted: "文档已加密，请解密后再添加。",
            too_many_pages: "PDF 不能超过100页，请选取需要的章节。",
            unsupported: "文档格式不受支持，请导出为普通 PDF 或 DOCX。",
            parse_error: "文档未能解析，可能损坏或内容过大。",
            cancelled: CANCELLED,
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
    if (signal?.aborted === true) return fail(CANCELLED);
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

/** A card's job id from the renderer: data, so bounded and printable or nothing. */
const jobId = (job: unknown): string | undefined =>
  typeof job === "string" && /^[\w-]{1,120}$/.test(job) ? job : undefined;

/**
 * The chat's file reader (R118): one file at a time, as before, now cancellable by the card's
 * job id. Until R118 a cancelled card only hid the result — the read went on in this process
 * and held the one-at-a-time lock until it was done.
 */
export function createChatFileReader(
  parse: typeof parseChatFile = parseChatFile,
) {
  let running: {
    readonly job: string | undefined;
    readonly controller: AbortController;
  } | null = null;
  return {
    async parse(
      name: unknown,
      data: unknown,
      job?: unknown,
    ): Promise<ChatFileResult> {
      if (running) return fail("请等待当前附件解析完成。");
      const controller = new AbortController();
      running = { job: jobId(job), controller };
      try {
        return await parse(name, data, controller.signal);
      } finally {
        running = null;
      }
    },
    /** True when the file being read is `job`'s and has been told to stop. */
    cancel(job: unknown): boolean {
      const id = jobId(job);
      if (id === undefined || running?.job !== id) return false;
      running.controller.abort();
      return true;
    },
  };
}
