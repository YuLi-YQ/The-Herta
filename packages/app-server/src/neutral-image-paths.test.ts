import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SystemBlock } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fromJournal,
  type ImagePreparer,
  planExecutorPictures,
  planImages,
  readPicture,
} from "./neutral-images.js";
import { makePng } from "./testing/image-fixtures.js";

// R128: a lexical session prefix does not make a linked file an owned attachment.
// All targets here are synthetic siblings of the workspace; no private data or API.
const parts = [".herta", "attachments", "session-one", "picture.png"];
const path = parts.join("/");
const png = makePng(2, 3);
let base: string;
let root: string;
const links: string[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "herta-image-paths-"));
  root = join(base, "workspace");
  mkdirSync(root);
});
afterEach(() => {
  // Unlink junctions themselves before recursively cleaning the synthetic fixture.
  for (const link of links.splice(0)) unlinkSync(link);
  rmSync(base, { recursive: true, force: true });
});

const record: SystemBlock[] = [
  {
    kind: "system",
    label: "系统",
    body: "Synthetic picture",
    digest: {
      kind: "attachment",
      name: "picture.png",
      path,
      lines: 0,
      chars: 0,
      image: { format: "png", width: 2, height: 3 },
    },
  },
];
const routes = ["read", "persona", "executor", "journal"] as const;
type Route = (typeof routes)[number];
async function sent(route: Route): Promise<string[]> {
  const opts = {
    root,
    sessionId: "session-one",
    record,
    freshFrom: 0,
    supported: true,
  };
  if (route === "read") {
    const image = await readPicture(root, path);
    return image ? [image.data] : [];
  }
  if (route === "persona") {
    const plan = await planImages(opts);
    return [...plan.sent.values()].map((image) => image.data);
  }
  const messages =
    route === "executor"
      ? (await planExecutorPictures(opts)).messages
      : await fromJournal(
          [{ role: "user", text: "Synthetic picture", imageRefs: [path] }],
          { ...opts, refs: new Map() },
        );
  return messages.flatMap((m) =>
    m.role === "user" ? (m.images ?? []).map((image) => image.data) : [],
  );
}

/** Link one path component to a sibling outside the workspace. */
function linkedCopy(index: number): string {
  const file = index === parts.length - 1;
  const target = join(base, "outside", ...(file ? ["picture.png"] : []));
  const targetFile = file ? target : join(target, ...parts.slice(index + 1));
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, png);
  const link = join(root, ...parts.slice(0, index + 1));
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, file ? "file" : "junction");
  links.push(link);
  return targetFile;
}

describe.each(routes)("owned picture path via %s", (route) => {
  it.each(
    parts.map((part, index) => ({ part, index })),
  )("refuses a link at $part instead of sending its target", async ({
    index,
  }) => {
    const target = linkedCopy(index);
    expect(await sent(route)).toEqual([]);
    expect(readFileSync(target)).toEqual(png);
  });

  it("still sends a normal owned attachment", async () => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), png);
    expect(await sent(route)).toEqual([png.toString("base64")]);
  });
});

it("keeps preparation available for a normal owned picture over the request size", async () => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const oversized = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
  writeFileSync(join(root, path), oversized);
  const prepare = vi.fn<ImagePreparer>(async () => ({
    mimeType: "image/png",
    data: png.toString("base64"),
  }));
  expect(await readPicture(root, path, prepare)).toEqual({
    mimeType: "image/png",
    data: png.toString("base64"),
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]?.[0].equals(oversized)).toBe(true);
});
