/**
 * A test-only IndexedDB with what the pending chat attachments use (R101): jsdom has none.
 * A transaction works on a copy of its stores and commits once no request is left; a
 * throwing handler or a failing request aborts it, as in a browser. `fail` injects the
 * failures a real profile can hit, and `hold` keeps databases from opening until released.
 */
export function memoryIdb() {
  const stores = new Map<string, Map<unknown, unknown>>();
  const fail: { open?: "error" | "throw" | "blocked"; get?: boolean; put?: boolean; commit?: boolean } = {};
  const seen = { commits: 0, durability: [] as unknown[] };
  let autoKey = 0;
  let held: (() => void)[] | null = null;
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    transaction(names: string | string[], mode: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (mode === "readwrite") seen.durability.push(options?.durability);
      const staged = new Map(
        (Array.isArray(names) ? names : [names]).map((n) => [n, new Map(stores.get(n))]),
      );
      let pending = 0;
      let finished = false;
      const tx: {
        oncomplete?: () => void;
        onabort?: () => void;
        abort(): void;
        objectStore(name: string): unknown;
      } = {
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name: string) {
          const data = staged.get(name) as Map<unknown, unknown>;
          const request = (run: () => unknown, failing = false) => {
            const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
            pending++;
            queueMicrotask(() => {
              pending--;
              if (finished) return;
              try {
                if (failing) {
                  req.onerror?.();
                  return tx.abort();
                }
                req.result = run();
                req.onsuccess?.();
              } catch {
                return tx.abort();
              }
              settle();
            });
            return req;
          };
          const writable = () => {
            if (mode !== "readwrite") throw new DOMException("read only", "ReadOnlyError");
          };
          const write = (value: unknown) => {
            writable();
            if (fail.put) throw new DOMException("cannot clone", "DataCloneError");
            return structuredClone(value);
          };
          return {
            get: (key: unknown) => request(() => structuredClone(data.get(key)), fail.get),
            put: (value: unknown, key: unknown) => {
              const copy = write(value);
              return request(() => data.set(key, copy));
            },
            add: (value: unknown) => {
              const copy = write(value);
              return request(() => data.set(++autoKey, copy));
            },
            delete: (key: unknown) => {
              writable();
              return request(() => data.delete(key));
            },
          };
        },
      };
      const settle = () => {
        if (finished || pending > 0) return;
        finished = true;
        if (fail.commit) return queueMicrotask(() => tx.onabort?.());
        if (mode === "readwrite") {
          for (const [name, data] of staged) stores.set(name, data);
          seen.commits++;
        }
        queueMicrotask(() => tx.oncomplete?.());
      };
      queueMicrotask(settle);
      return tx;
    },
    close() {},
  };
  const idb = {
    open() {
      if (fail.open === "throw") throw new Error("storage disabled");
      const request: {
        result?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
      } = {};
      const proceed = () => {
        if (fail.open === "error") return request.onerror?.();
        if (fail.open === "blocked") return request.onblocked?.();
        request.result = db;
        if (!stores.has("pending")) request.onupgradeneeded?.();
        request.onsuccess?.();
      };
      if (held) held.push(proceed);
      else queueMicrotask(proceed);
      return request;
    },
  } as unknown as IDBFactory;
  const pending = () => stores.get("pending") ?? new Map();
  const aside = () => stores.get("set-aside") ?? new Map();
  const hold = () => {
    held = [];
    return () => {
      const waiting = held ?? [];
      held = null;
      for (const proceed of waiting) proceed();
    };
  };
  const opening = () => held?.length ?? 0;
  /** A record as an earlier launch, or another version, left it. */
  const seed = (key: unknown, value: unknown) => {
    for (const name of ["pending", "set-aside"]) if (!stores.has(name)) stores.set(name, new Map());
    stores.get("pending")?.set(key, value);
  };
  return { idb, fail, seen, pending, aside, hold, opening, seed };
}
