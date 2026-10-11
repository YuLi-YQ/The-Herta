import { useCallback } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import type { StagedImageInfo } from "../../ipc/bridge-types.js";

/**
 * Pictures waiting in the composer (ADR 0048 §4).
 *
 * Session-SCOPED, deliberately: staged images are transient per-session state,
 * the exact class the 2026-07-19 audit caught leaking ("the pill survived
 * session delete"). Switching sessions must not carry someone's half-composed
 * screenshot into another conversation's strip — the ids would not resolve
 * there anyway, since the store lives on the session that made them.
 *
 * The renderer holds only handles: the bytes are already on disk in the
 * session's attachment directory, and the strip draws them through the
 * `herta-attachment://` scheme rather than carrying a data URI around.
 */
export interface StagedImagesState {
  readonly staged: readonly StagedImageInfo[];
  /** Stage files by path (picker / drop). Non-images are returned so the
   *  caller can route them to the document path instead. */
  readonly stagePaths: (
    paths: readonly string[],
  ) => Promise<{ readonly notImages: readonly string[] }>;
  /** Stage raw bytes (paste — a clipboard screenshot has no path). */
  readonly stageBytes: (
    items: readonly { readonly name: string; readonly bytes: Uint8Array }[],
  ) => Promise<void>;
  readonly unstage: (id: string) => void;
  /** Take the staged pictures to send with a message and clear the strip.
   *  Full infos, not ids: the optimistic echo shows them, and the failure
   *  paths hand them back through `restore`. */
  readonly take: () => readonly StagedImageInfo[];
  /** Put pictures back in the strip — a failed submit or a cancelled no-key
   *  card returns what `take` removed. The staged copies still exist
   *  main-side (only a successful submit's `commit` consumes them), so the
   *  ids stay valid. Deduped by id: a double-restore must not double the
   *  strip. */
  readonly restore: (infos: readonly StagedImageInfo[]) => void;
}

export function useStagedImages(
  sessionId: string | null,
  onRefusal: (message: string) => void,
): StagedImagesState {
  const { bridge } = useHertaBridge();
  const [staged, setStaged] = useSessionScoped<readonly StagedImageInfo[]>([]);

  const stage = useCallback(
    async (
      inputs: readonly {
        readonly path?: string;
        readonly bytes?: Uint8Array;
        readonly name?: string;
      }[],
    ): Promise<{ readonly notImages: readonly string[] }> => {
      if (sessionId === null || inputs.length === 0) return { notImages: [] };
      let reply: Awaited<ReturnType<typeof bridge.stageImages>>;
      try {
        reply = await bridge.stageImages(sessionId, inputs);
      } catch {
        onRefusal("failed");
        return { notImages: [] };
      }
      if (!reply.ok) {
        // Refusals are SHOWN, never silent — the same rule the drop target
        // learned in the M6 audit.
        onRefusal(reply.message ?? "failed");
        return { notImages: [] };
      }
      if (reply.staged.length > 0) {
        setStaged((prev) => [...prev, ...reply.staged]);
      }
      // `not_image` is not an error: documents ingest immediately through the
      // ordinary attach path, so the caller re-routes those rather than
      // telling the user anything went wrong.
      const notImages = reply.rejected
        .filter((r) => r.reason === "not_image")
        .map((r) => r.name);
      const refused = reply.rejected.filter((r) => r.reason !== "not_image");
      if (refused.length > 0) {
        onRefusal(refused[0]?.reason === "denied" ? "denied" : "failed");
      }
      return { notImages };
    },
    [bridge, sessionId, setStaged, onRefusal],
  );

  const stagePaths = useCallback(
    (paths: readonly string[]) => stage(paths.map((path) => ({ path }))),
    [stage],
  );

  const stageBytes = useCallback(
    async (
      items: readonly { readonly name: string; readonly bytes: Uint8Array }[],
    ) => {
      await stage(items.map((i) => ({ name: i.name, bytes: i.bytes })));
    },
    [stage],
  );

  const unstage = useCallback(
    (id: string) => {
      // Optimistic: the strip drops the thumbnail immediately. The stored copy
      // is deleted in the background — a failure there leaves a stray file
      // nothing references, never a thumbnail the user cannot remove.
      setStaged((prev) => prev.filter((s) => s.id !== id));
      if (sessionId !== null) void bridge.unstageImage(sessionId, id);
    },
    [bridge, sessionId, setStaged],
  );

  const take = useCallback((): readonly StagedImageInfo[] => {
    setStaged([]);
    return staged;
  }, [staged, setStaged]);

  const restore = useCallback(
    (infos: readonly StagedImageInfo[]) => {
      if (infos.length === 0) return;
      setStaged((prev) => {
        const have = new Set(prev.map((s) => s.id));
        return [...prev, ...infos.filter((i) => !have.has(i.id))];
      });
    },
    [setStaged],
  );

  return { staged, stagePaths, stageBytes, unstage, take, restore };
}
