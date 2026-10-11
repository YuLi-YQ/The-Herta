import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentImageUrl } from "../shared/attachment-image.js";
import {
  resolveAttachmentPath,
  resolveAttachmentPathPhysical,
} from "./attachment-protocol.js";

// win32 spells the root differently; the guard is the same shape either way.
const ROOT = process.platform === "win32" ? "E:\\repo" : "/repo";
const sep = process.platform === "win32" ? "\\" : "/";

const resolveUrl = (url: string) => resolveAttachmentPath(url, ROOT);
const resolveRel = (rel: string) => resolveUrl(attachmentImageUrl(rel));
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function physicalFixture() {
  const parent = mkdtempSync(join(tmpdir(), "herta-r4-attachment-"));
  temporaryRoots.push(parent);
  const root = join(parent, "项目 中文");
  const attachments = join(root, ".herta", "attachments");
  const outside = join(parent, "outside");
  mkdirSync(attachments, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "outside.png"), "filesystem-only fixture");
  return { root, attachments, outside };
}

describe("physical attachment jail", () => {
  it("keeps an ordinary Chinese-named image inside the current workspace", async () => {
    const { root, attachments } = physicalFixture();
    const file = join(attachments, "图片 中文.png");
    writeFileSync(file, "filesystem-only fixture");
    expect(
      await resolveAttachmentPathPhysical(
        attachmentImageUrl(".herta/attachments/图片 中文.png"),
        root,
      ),
    ).toBe(realpathSync.native(file));
    expect(
      await resolveAttachmentPathPhysical(
        attachmentImageUrl(".herta/attachments/missing.png"),
        root,
      ),
    ).toBeNull();
  });

  it("rejects an attachment-root junction itself even when its name passes the lexical jail", async () => {
    const { root, attachments, outside } = physicalFixture();
    rmSync(attachments, { recursive: true });
    symlinkSync(
      outside,
      attachments,
      process.platform === "win32" ? "junction" : "dir",
    );
    const url = attachmentImageUrl(".herta/attachments/outside.png");
    expect(resolveAttachmentPath(url, root)).not.toBeNull();
    expect(await resolveAttachmentPathPhysical(url, root)).toBeNull();
  });

  it("rejects a child junction whose target image is outside the workspace", async () => {
    const { root, attachments, outside } = physicalFixture();
    symlinkSync(
      outside,
      join(attachments, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      await resolveAttachmentPathPhysical(
        attachmentImageUrl(".herta/attachments/escaped/outside.png"),
        root,
      ),
    ).toBeNull();
  });

  it("rejects a file symlink to an outside image", async (context) => {
    const { root, attachments, outside } = physicalFixture();
    try {
      symlinkSync(
        join(outside, "outside.png"),
        join(attachments, "linked.png"),
        "file",
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    expect(
      await resolveAttachmentPathPhysical(
        attachmentImageUrl(".herta/attachments/linked.png"),
        root,
      ),
    ).toBeNull();
  });
});

describe("resolveAttachmentPath", () => {
  it("resolves a stored attachment under the workspace", () => {
    expect(resolveRel(".herta/attachments/s1/shot-ab12cd34.png")).toBe(
      [ROOT, ".herta", "attachments", "s1", "shot-ab12cd34.png"].join(sep),
    );
  });

  it("round-trips a filename that needs encoding", () => {
    // Attachment names keep the user's own spelling; the URL must survive
    // spaces, parentheses and CJK.
    expect(resolveRel(".herta/attachments/s1/报告 (最终)-ab12cd34.png")).toBe(
      [ROOT, ".herta", "attachments", "s1", "报告 (最终)-ab12cd34.png"].join(
        sep,
      ),
    );
  });

  it("refuses anything outside the attachment tree", () => {
    // The renderer is sandboxed from the filesystem on purpose. This scheme
    // must not become a read-any-file primitive for it.
    expect(resolveRel("package.json")).toBe(null);
    expect(resolveRel(".herta/settings.json")).toBe(null);
    expect(resolveRel(".herta/logs/run.log")).toBe(null);
    expect(resolveRel("src/main/key-store.ts")).toBe(null);
  });

  it("refuses a traversal that escapes the workspace", () => {
    expect(resolveRel(".herta/attachments/../../../etc/passwd")).toBe(null);
    expect(resolveRel("../outside.png")).toBe(null);
  });

  it("refuses a traversal that lands back inside the root but outside attachments", () => {
    // The subtle one: this stays under the workspace, so a root-only guard
    // would pass it. The claim AND the resolved path are both checked.
    expect(resolveRel(".herta/attachments/../settings.json")).toBe(null);
    expect(resolveRel(".herta/attachments/s1/../../logs/run.log")).toBe(null);
  });

  it("refuses an absolute path injected as the relative one", () => {
    expect(resolveUrl("herta-attachment://file//etc/passwd")).toBe(null);
    expect(resolveUrl("herta-attachment://file/C:/Windows/win.ini")).toBe(null);
  });

  it("refuses a malformed URL or an empty path", () => {
    expect(resolveUrl("not a url")).toBe(null);
    expect(resolveUrl("herta-attachment://file/")).toBe(null);
    expect(resolveUrl("herta-attachment://file/%E0%A4%A")).toBe(null);
  });

  it("refuses a backslash-spelled path that dodges the prefix check", () => {
    // A Windows-style separator must not let `.herta\attachments\..` slip
    // past a check written for forward slashes.
    expect(
      resolveUrl("herta-attachment://file/.herta%5Cattachments%5C..%5Cx.png"),
    ).toBe(null);
  });
});
