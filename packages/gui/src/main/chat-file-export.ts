import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A user-selected save path is the only way out of the chat's text artifacts. */
export function createChatFileSaver(deps: {
  directory: string;
  choose: (
    defaultPath: string,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
}) {
  return async (name: unknown, content: unknown) => {
    if (
      typeof name !== "string" ||
      typeof content !== "string" ||
      content.length > 512000
    )
      return { saved: false, failed: true };
    const safeName = name
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 100);
    const suggested =
      !safeName || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safeName)
        ? "Herta-document.txt"
        : safeName;
    const chosen = await deps.choose(join(deps.directory, suggested));
    if (chosen.canceled || !chosen.filePath) return { saved: false };
    try {
      await writeFile(chosen.filePath, content, "utf8");
      return { saved: true };
    } catch {
      return { saved: false, failed: true };
    }
  };
}
