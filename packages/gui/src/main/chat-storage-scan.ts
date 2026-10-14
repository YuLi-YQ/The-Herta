import { Worker } from "node:worker_threads";
import type { ChatStorageUsage } from "../shared/herta-chat.js";

/** At most one bounded scan per chat store; the renderer supplies no filesystem paths. */
export function createChatStorageScan(path: string) {
  let pending: Promise<ChatStorageUsage> | undefined;
  let cancel: (() => void) | undefined;
  let disposed = false;
  const failure = () => new Error("存储用量暂时无法读取，请稍后刷新。");
  return {
    run(): Promise<ChatStorageUsage> {
      if (disposed) return Promise.reject(failure());
      if (pending) return pending;
      const task = new Promise<ChatStorageUsage>((resolve, reject) => {
        const worker = new Worker(new URL("./chat-storage-worker.js", import.meta.url), {
          workerData: { path }, resourceLimits: { maxOldGenerationSizeMb: 384 },
        });
        let settled = false;
        const finish = (usage?: ChatStorageUsage) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cancel = undefined;
          void worker.terminate().catch(() => {});
          usage ? resolve(usage) : reject(failure());
        };
        const timeout = setTimeout(() => finish(), 30000);
        timeout.unref?.();
        cancel = () => finish();
        worker.once("message", message => finish(message?.ok === true ? message.usage : undefined));
        worker.once("error", () => finish());
        worker.once("exit", () => finish());
      });
      pending = task.catch(() => { throw failure(); }).finally(() => { pending = undefined; });
      return pending;
    },
    dispose() { disposed = true; cancel?.(); },
  };
}
