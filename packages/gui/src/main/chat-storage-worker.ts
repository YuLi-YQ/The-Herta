import { parentPort, workerData } from "node:worker_threads";
import { statSync } from "node:fs";
import { auditChatImages } from "./chat-image-audit.js";
import { createChatImageStore } from "./chat-image-store.js";

try {
  if (typeof workerData?.path !== "string") throw new Error();
  const path = workerData.path;
  const images = createChatImageStore(`${path}.images`).usage();
  const audit = auditChatImages(path);
  parentPort?.postMessage({ ok: true, usage: {
    checkedAt: new Date().toISOString(), historyBytes: statSync(path).size,
    historyLimitBytes: 64 * 1024 * 1024, images, audit,
  } });
} catch { parentPort?.postMessage({ ok: false }); }
