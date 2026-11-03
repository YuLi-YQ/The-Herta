// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolAdapter, ProviderProtocol } from "@herta/providers";
import type { ImageRequestRefused } from "@herta/providers/images";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (s: string) => Buffer.from(s).map((b) => b ^ 85),
    decryptString: (b: Buffer) => Buffer.from(b.map((v) => v ^ 85)).toString(),
  },
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => {
    throw new Error("Inject deterministic adapter in tests");
  },
}));

import {
  quarantineImageChecks,
  recordImageCheck,
} from "./provider-image-checks.js";
import { validateProviderModel } from "./provider-probes.js";
import {
  getProviderSettings,
  recordImageRequestRefused,
  saveProvider,
  updateProviderModels,
} from "./provider-settings.js";

// R109 (F06): image results get a date and a connection, in a file beside the settings.
// Deterministic main-process tests with injected adapters, not service verification.
const records = () => join(state.root, "provider-image-checks.json");
const settingsFile = () => join(state.root, "provider-settings.json");
const create = (
  models = ["manual"],
  protocol: ProviderProtocol = "openai-chat-completions",
) =>
  saveProvider({
    name: "images",
    protocol,
    baseURL: "https://example.invalid/v1",
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: models.map((id) => ({ id })),
    defaults: { model: models[0]!, timeoutMs: 2000 },
    credential: { action: "replace", value: "synthetic-secret" },
  }).settings.providers[0]!;
const resave = (
  changes: {
    name?: string;
    models?: string[];
    model?: string;
    baseURL?: string;
    protocol?: ProviderProtocol;
    key?: string;
  } = {},
) => {
  const p = getProviderSettings().settings.providers[0]!;
  const models = changes.models ?? p.models.map((m) => m.id);
  return saveProvider({
    id: p.id,
    expectedRevision: p.revision,
    name: changes.name ?? p.name,
    protocol: changes.protocol ?? p.protocol,
    baseURL: changes.baseURL ?? p.baseURL,
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: models.map((id) => ({ id })),
    defaults: {
      model:
        changes.model ??
        (models.includes(p.defaults.model) ? p.defaults.model : models[0]!),
      timeoutMs: 2000,
    },
    credential: changes.key
      ? { action: "replace", value: changes.key }
      : { action: "keep" },
  }).settings.providers[0]!;
};
/** Math.random is pinned to 0, so the probe picture is red, green / blue, yellow. */
const reading = (reply: string): ProtocolAdapter => ({
  protocol: "openai-chat-completions",
  async *stream() {
    yield { type: "text-delta", text: reply };
    yield { type: "finished", reason: "stop" };
  },
  async listModels() {
    return { models: [], nextCursor: null };
  },
});
const sees = () => reading("red green blue yellow");
const imageProbe = (
  modelId = "manual",
  adapter: () => ProtocolAdapter = sees,
) => {
  const p = getProviderSettings().settings.providers[0]!;
  return validateProviderModel(
    { providerId: p.id, expectedRevision: p.revision, modelId, kind: "images" },
    adapter,
  );
};
const checkFor = (modelId = "manual") =>
  getProviderSettings().imageChecks?.find((c) => c.modelId === modelId);

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "herta-r109-image-checks-"));
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("dates an image verdict beside the settings and leaves provider-settings.json in the shape older versions read", async () => {
  create();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T01:00:00.000Z"));
  const passed = await imageProbe();
  expect(passed.images).toEqual({ supported: true });
  expect(passed.view.imageChecks).toEqual([
    {
      providerId: passed.view.settings.providers[0]!.id,
      modelId: "manual",
      checkedAt: "2026-10-29T01:00:00.000Z",
    },
  ]);
  vi.setSystemTime(new Date("2026-10-29T02:00:00.000Z"));
  const refused = await imageProbe("manual", () =>
    reading("blue blue blue blue"),
  );
  expect(refused.images?.supported).toBe(false);
  // An "unsupported" verdict is a measured result too, and dated the same way.
  expect(refused.view.imageChecks?.[0]?.checkedAt).toBe(
    "2026-10-29T02:00:00.000Z",
  );
  // The R104 loader's allow-lists (provider-settings.ts load): nothing new reached the main file.
  const saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  const model = saved.providers[0].models[0];
  expect(Object.keys(model).sort()).toEqual([
    "capabilities",
    "id",
    "source",
    "validation",
  ]);
  expect(Object.keys(model.capabilities).sort()).toEqual([
    "images",
    "reasoning",
    "streaming",
    "tools",
  ]);
  expect(Object.keys(model.validation).sort()).toEqual([
    "protocol",
    "providerRevision",
    "state",
  ]);
  expect(model.capabilities.images).toBe("unsupported");
  const file = JSON.parse(readFileSync(records(), "utf8"));
  expect(file).toEqual({
    schemaVersion: 1,
    entries: [
      {
        providerId: saved.providers[0].id,
        modelId: "manual",
        images: {
          result: "unsupported",
          checkedAt: "2026-10-29T02:00:00.000Z",
          providerRevision: 1,
          protocol: "openai-chat-completions",
          connection: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      },
    ],
  });
  // Neither the address nor the key reference is written beside the settings.
  expect(readFileSync(records(), "utf8")).not.toMatch(
    /example\.invalid|provider-[0-9a-f-]{36}/,
  );
});

it("keeps the date across a save that keeps the connection (rename, other default model)", async () => {
  create(["manual", "other"]);
  const passed = await imageProbe();
  const checkedAt = passed.view.imageChecks?.[0]?.checkedAt;
  expect(checkedAt).toBeTruthy();
  const renamed = resave({ name: "renamed", model: "other" });
  expect(renamed.revision).toBe(2);
  expect(
    renamed.models.find((m) => m.id === "manual")?.capabilities.images,
  ).toBe("supported");
  expect(checkFor()).toEqual({
    providerId: renamed.id,
    modelId: "manual",
    checkedAt,
  });
});

it.each([
  ["a replaced key at the same address", { key: "another-synthetic-secret" }],
  ["another address", { baseURL: "https://other.invalid/v1" }],
  ["another protocol", { protocol: "anthropic-messages" as const }],
])("after %s the reset image result says it needs testing again", async (_name, change) => {
  create();
  await imageProbe();
  const changed = resave(change);
  expect(changed.models[0]!.capabilities.images).toBe("unknown");
  expect(checkFor()).toEqual({
    providerId: changed.id,
    modelId: "manual",
    connectionChanged: true,
  });
  // Testing again on the new connection dates the new result and ends the notice.
  await imageProbe();
  expect(checkFor()).toEqual({
    providerId: changed.id,
    modelId: "manual",
    checkedAt: expect.any(String),
  });
});

it("shows no old date for a model added again, and drops entries of removed models on the next write", async () => {
  create(["manual", "other"]);
  await imageProbe("manual");
  resave({ models: ["other"] });
  expect(checkFor("manual")).toBeUndefined();
  const again = resave({ models: ["other", "manual"] });
  expect(again.models.find((m) => m.id === "manual")?.capabilities.images).toBe(
    "unknown",
  );
  // Same connection, but the record names a result the model no longer has: not shown.
  expect(checkFor("manual")).toBeUndefined();
  resave({ models: ["other"] });
  await imageProbe("other");
  const file = JSON.parse(readFileSync(records(), "utf8"));
  expect(file.entries.map((e: { modelId: string }) => e.modelId)).toEqual([
    "other",
  ]);
});

it("a probe that saves nothing writes no date, and a late older probe does not replace a newer one", async () => {
  create();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T01:00:00.000Z"));
  await imageProbe();
  const before = readFileSync(records(), "utf8");
  vi.setSystemTime(new Date("2026-10-29T02:00:00.000Z"));
  const timedOut = await imageProbe("manual", () => ({
    ...sees(),
    // biome-ignore lint/correctness/useYield: the request fails before any event
    async *stream() {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  }));
  expect(timedOut.kept?.reason).toBe("transient");
  expect(readFileSync(records(), "utf8")).toBe(before);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const older = imageProbe("manual", () => ({
    ...sees(),
    async *stream() {
      await gate;
      yield { type: "text-delta", text: "blue blue blue blue" };
      yield { type: "finished", reason: "stop" };
    },
  }));
  vi.setSystemTime(new Date("2026-10-29T03:00:00.000Z"));
  await imageProbe();
  release();
  expect((await older).superseded).toBe(true);
  expect(checkFor()?.checkedAt).toBe("2026-10-29T03:00:00.000Z");
  expect(
    getProviderSettings().settings.providers[0]!.models[0]!.capabilities.images,
  ).toBe("supported");
});

it.each([
  ["not JSON", "{ torn"],
  ["a newer format", JSON.stringify({ schemaVersion: 2, entries: [] })],
  ["the wrong shape", JSON.stringify({ schemaVersion: 1, entries: {} })],
])("a record file that is %s is never overwritten; results still save and an explicit reset starts over", async (_name, bytes) => {
  create();
  writeFileSync(records(), bytes);
  const passed = await imageProbe();
  expect(passed.images).toEqual({ supported: true });
  expect(
    passed.view.settings.providers[0]!.models[0]!.capabilities.images,
  ).toBe("supported");
  expect(passed.view.imageCheckIssue).toBe("unreadable");
  expect(passed.view.imageChecks).toEqual([]);
  expect(readFileSync(records(), "utf8")).toBe(bytes);
  const moved = quarantineImageChecks(new Date("2026-10-29T04:05:06.789Z"));
  expect(moved).toBe(
    "provider-image-checks.json.damaged-2026-10-29T04-05-06-789Z",
  );
  expect(readFileSync(join(state.root, moved), "utf8")).toBe(bytes);
  expect(existsSync(records())).toBe(false);
  expect(getProviderSettings().imageCheckIssue).toBeUndefined();
  await imageProbe();
  expect(checkFor()?.checkedAt).toBeTruthy();
  // Only an unreadable file can be reset; a second reset of the same moment gets its own name.
  expect(() => quarantineImageChecks()).toThrow("无需重置");
  writeFileSync(records(), bytes);
  expect(quarantineImageChecks(new Date("2026-10-29T04:05:06.789Z"))).toBe(
    "provider-image-checks.json.damaged-2026-10-29T04-05-06-789Z-2",
  );
  expect(
    readdirSync(state.root).filter((n) => n.includes(".damaged-")),
  ).toHaveLength(2);
});

it("keeps fields and entries a later version wrote, and ignores them", async () => {
  const p = create();
  const later = {
    schemaVersion: 1,
    written: "by a later version",
    entries: [
      { kind: "not an entry this version knows" },
      {
        providerId: p.id,
        modelId: "manual",
        // R110 gave imageReview a meaning, so a name no version uses stands in for a later field.
        imageNote: { at: "2026-10-28T00:00:00.000Z" },
      },
    ],
  };
  writeFileSync(records(), JSON.stringify(later));
  expect(getProviderSettings().imageChecks).toEqual([]);
  await imageProbe();
  const file = JSON.parse(readFileSync(records(), "utf8"));
  expect(file.written).toBe("by a later version");
  expect(file.entries[0]).toEqual(later.entries[0]);
  expect(file.entries[1]).toEqual({
    ...later.entries[1],
    images: expect.objectContaining({ result: "supported" }),
  });
  expect(checkFor()?.checkedAt).toBeTruthy();
});

it("a result saved on another connection without a date (an older version after a rollback) shows neither a date nor a notice", async () => {
  create();
  await imageProbe();
  const changed = resave({ key: "another-synthetic-secret" });
  // What an older version's image probe does: the result only, no record.
  updateProviderModels(changed.id, changed.revision, (models) =>
    models.map((m) => ({
      ...m,
      capabilities: { ...m.capabilities, images: "supported" as const },
    })),
  );
  expect(checkFor()).toBeUndefined();
});

it("treats model IDs as data, even an Object prototype name", async () => {
  create(["__proto__", "constructor"]);
  await imageProbe("__proto__");
  await imageProbe("constructor");
  const checks = getProviderSettings().imageChecks ?? [];
  expect(checks.map((c) => c.modelId).sort()).toEqual([
    "__proto__",
    "constructor",
  ]);
  expect(checks.every((c) => typeof c.checkedAt === "string")).toBe(true);
});

it("records nothing for a result the settings do not hold", () => {
  const p = create();
  const settings = getProviderSettings().settings;
  expect(recordImageCheck(settings, p.id, "manual", "supported")).toBe(false);
  expect(recordImageCheck(settings, p.id, "missing", "unsupported")).toBe(
    false,
  );
  expect(existsSync(records())).toBe(false);
});

// R110 (F06): a refused request that carried pictures marks the model for review in the same file.
const refused = (changes: Partial<ImageRequestRefused> = {}) => {
  const p = getProviderSettings().settings.providers[0]!;
  return recordImageRequestRefused({
    providerId: p.id,
    providerRevision: p.revision,
    modelId: "manual",
    status: 400,
    surface: "workbench",
    ...changes,
  });
};
const entryFor = (modelId = "manual") =>
  JSON.parse(readFileSync(records(), "utf8")).entries.find(
    (e: { modelId?: string }) => e.modelId === modelId,
  );
const timesOut = () => ({
  ...sees(),
  // biome-ignore lint/correctness/useYield: the request fails before any event
  async *stream() {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  },
});

it("marks a refused request for review beside the settings; the result, its date and provider-settings.json stay as they were", async () => {
  const p = create();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T01:00:00.000Z"));
  await imageProbe();
  const settingsBefore = readFileSync(settingsFile(), "utf8");
  vi.setSystemTime(new Date("2026-10-29T03:00:00.000Z"));
  expect(refused({ status: 422, surface: "chat" })).toBe(true);
  expect(readFileSync(settingsFile(), "utf8")).toBe(settingsBefore);
  expect(
    getProviderSettings().settings.providers[0]!.models[0]!.capabilities.images,
  ).toBe("supported");
  expect(checkFor()).toEqual({
    providerId: p.id,
    modelId: "manual",
    checkedAt: "2026-10-29T01:00:00.000Z",
    review: { at: "2026-10-29T03:00:00.000Z", status: 422, surface: "chat" },
  });
  const entry = entryFor();
  expect(entry.imageReview).toEqual({
    at: "2026-10-29T03:00:00.000Z",
    status: 422,
    surface: "chat",
    images: "supported",
    providerRevision: 1,
    protocol: "openai-chat-completions",
    connection: entry.images.connection,
  });
  expect(JSON.parse(readFileSync(records(), "utf8")).schemaVersion).toBe(1);
  expect(readFileSync(records(), "utf8")).not.toMatch(
    /example\.invalid|provider-[0-9a-f-]{36}|synthetic-secret/,
  );
});

it("a conclusive image check clears the review; a check that saves nothing leaves it", async () => {
  create();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T01:00:00.000Z"));
  await imageProbe();
  vi.setSystemTime(new Date("2026-10-29T02:00:00.000Z"));
  expect(refused()).toBe(true);
  vi.setSystemTime(new Date("2026-10-29T03:00:00.000Z"));
  expect((await imageProbe("manual", timesOut)).kept?.reason).toBe("transient");
  expect(checkFor()?.review?.at).toBe("2026-10-29T02:00:00.000Z");
  // A failed check is a conclusion too: it answers the review, and the result it measured stands.
  vi.setSystemTime(new Date("2026-10-29T04:00:00.000Z"));
  const answered = await imageProbe("manual", () =>
    reading("blue blue blue blue"),
  );
  expect(answered.images?.supported).toBe(false);
  expect(answered.view.imageChecks).toEqual([
    {
      providerId: expect.any(String),
      modelId: "manual",
      checkedAt: "2026-10-29T04:00:00.000Z",
    },
  ]);
  expect(entryFor()).not.toHaveProperty("imageReview");
});

it("marks a model no image check has measured, such as a documented vision model", () => {
  const p = create();
  expect(refused({ status: 415 })).toBe(true);
  expect(checkFor()).toEqual({
    providerId: p.id,
    modelId: "manual",
    review: { at: expect.any(String), status: 415, surface: "workbench" },
  });
  expect(entryFor()).not.toHaveProperty("images");
  expect(entryFor().imageReview.images).toBe("unknown");
});

it("writes nothing when the connection was saved since the request, the model is gone, or it is not a refusal", () => {
  const p = create();
  expect(refused({ providerRevision: p.revision + 1 })).toBe(false);
  resave({ name: "renamed" });
  expect(refused({ providerRevision: p.revision })).toBe(false);
  expect(refused({ modelId: "missing" })).toBe(false);
  expect(refused({ providerId: "missing" })).toBe(false);
  for (const status of [401, 403, 404, 413, 429, 500, 503])
    expect(refused({ status })).toBe(false);
  expect(refused({ surface: "elsewhere" as "chat" })).toBe(false);
  expect(existsSync(records())).toBe(false);
});

it("stops showing the review once the connection changes", async () => {
  create();
  await imageProbe();
  expect(refused()).toBe(true);
  // A changed connection resets the result: what is asked for is a new check, as in R109.
  const changed = resave({ key: "another-synthetic-secret" });
  expect(checkFor()).toEqual({
    providerId: changed.id,
    modelId: "manual",
    connectionChanged: true,
  });
});

it("an older version that saves another result without a record hides the review", () => {
  const p = create();
  expect(refused()).toBe(true);
  // What an older version's image probe does: the result only, no record.
  updateProviderModels(p.id, p.revision, (models) =>
    models.map((m) => ({
      ...m,
      capabilities: { ...m.capabilities, images: "supported" as const },
    })),
  );
  expect(checkFor()).toBeUndefined();
});

it("a later check an older version recorded (keeping the review it does not know) hides it", async () => {
  create();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T01:00:00.000Z"));
  await imageProbe();
  vi.setSystemTime(new Date("2026-10-29T02:00:00.000Z"));
  expect(refused()).toBe(true);
  // R109 rewrites the entry with a new date and keeps the fields it does not know.
  const file = JSON.parse(readFileSync(records(), "utf8"));
  file.entries[0].images.checkedAt = "2026-10-29T05:00:00.000Z";
  writeFileSync(records(), JSON.stringify(file));
  expect(checkFor()).toEqual({
    providerId: expect.any(String),
    modelId: "manual",
    checkedAt: "2026-10-29T05:00:00.000Z",
  });
});

it("never overwrites an unreadable record file to mark a review", () => {
  create();
  writeFileSync(records(), "{ torn");
  expect(refused()).toBe(false);
  expect(readFileSync(records(), "utf8")).toBe("{ torn");
  expect(getProviderSettings().imageCheckIssue).toBe("unreadable");
});

it("keeps fields and entries a later version wrote when marking, and ignores a review it cannot read", async () => {
  const p = create(["manual", "other"]);
  const later = {
    schemaVersion: 1,
    written: "by a later version",
    entries: [
      { kind: "not an entry this version knows" },
      { providerId: p.id, modelId: "manual", imageNote: { kept: true } },
      {
        providerId: p.id,
        modelId: "other",
        imageReview: { at: "2026-10-28T00:00:00.000Z", status: 499 },
      },
    ],
  };
  writeFileSync(records(), JSON.stringify(later));
  expect(getProviderSettings().imageChecks).toEqual([]);
  expect(refused()).toBe(true);
  const file = JSON.parse(readFileSync(records(), "utf8"));
  expect(file.written).toBe("by a later version");
  expect(file.entries[0]).toEqual(later.entries[0]);
  expect(file.entries).toContainEqual(later.entries[2]);
  expect(entryFor()).toMatchObject({
    imageNote: { kept: true },
    imageReview: expect.objectContaining({ status: 400 }),
  });
  expect(checkFor("other")).toBeUndefined();
});
