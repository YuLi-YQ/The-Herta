import { execFile } from "node:child_process";
import { basename } from "node:path";
export type CommandEncoding = "utf-8" | "gb18030" | "utf-16le";
let consoleEncoding: Promise<CommandEncoding> | undefined;
/** Only legacy Windows shells use the console code page by default. Other
 * programs keep UTF-8; callers can explicitly name their output encoding. */
export async function resolveCommandEncoding(
  argv: readonly string[],
  explicit?: CommandEncoding,
): Promise<CommandEncoding> {
  if (explicit) return explicit;
  if (process.platform !== "win32") return "utf-8";
  const program = basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (program !== "cmd" && program !== "powershell") return "utf-8";
  if (
    program === "cmd" &&
    argv
      .slice(
        1,
        argv.findIndex((a) => /^\/[ck]$/i.test(a)) < 0
          ? undefined
          : argv.findIndex((a) => /^\/[ck]$/i.test(a)),
      )
      .some((a) => /^\/u$/i.test(a))
  )
    return "utf-16le";
  consoleEncoding ??= new Promise((resolve) => {
    execFile(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/c", "chcp"],
      { windowsHide: true, timeout: 2000, encoding: "buffer" },
      (error, stdout) => {
        const page = error
          ? ""
          : stdout.toString("ascii").match(/\b(936|54936|65001)\b/)?.[1];
        resolve(page === "936" || page === "54936" ? "gb18030" : "utf-8");
      },
    );
  });
  return consoleEncoding;
}
/** Separate instance per stdout/stderr preserves split multibyte sequences. */
export class CommandOutputDecoder {
  private readonly decoder: TextDecoder;
  constructor(encoding: CommandEncoding) {
    this.decoder = new TextDecoder(encoding);
  }
  write(bytes: Buffer): string {
    return this.decoder.decode(bytes, { stream: true });
  }
  end(): string {
    return this.decoder.decode();
  }
}
export function decodeCommandOutput(
  bytes: Buffer,
  encoding: CommandEncoding,
): string {
  return new TextDecoder(encoding).decode(bytes);
}
