import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";

export interface TempDb {
  store: SqliteKnowledgeStore;
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

export function mkTempKnowledgeDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "herta-knowledge-"));
  const dbPath = join(dir, "test.sqlite");
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath });
  return {
    store,
    dir,
    dbPath,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
