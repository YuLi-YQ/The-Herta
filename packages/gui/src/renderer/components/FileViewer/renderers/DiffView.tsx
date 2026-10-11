import type { WorkingDiff } from "@herta/app-server";
import { useT } from "../../../i18n/LocaleProvider.js";
import { DiffBody } from "../../Workspace/DiffBody.js";
import { useFileViewerOpen } from "../file-viewer-context.js";
import { splitPatchByFile } from "./commit-patch.js";

/**
 * A path's working-tree change against HEAD beside the record (ADR 0059
 * §5): what a commit of this path would contain, staged and unstaged
 * together — an untracked file as a whole addition. The repository card's
 * dirty rows open here; the path in the header opens the live file. Same
 * chrome as a commit tab's file section, so the two read as one family.
 */
export function DiffView({
  diff,
}: {
  readonly diff: WorkingDiff;
}): JSX.Element {
  const t = useT();
  const openFile = useFileViewerOpen();
  const hunks = splitPatchByFile(diff.patch)[0] ?? "";
  const counts =
    diff.added === null && diff.deleted === null
      ? t("viewer.commit.binary")
      : `+${diff.added ?? 0} −${diff.deleted ?? 0}`;
  const live = openFile !== null && !diff.missing;
  return (
    <div className="file-viewer__body">
      <div
        className="file-viewer__scroll commit-view diff-view"
        data-testid="diff-view"
      >
        <header className="commit-view__head">
          <p className="commit-view__meta">
            <span>{t("viewer.diff.against")}</span>
            {diff.untracked && (
              <>
                <span className="commit-view__sep" aria-hidden="true">
                  ·
                </span>
                <span>{t("repo.card.status.untracked")}</span>
              </>
            )}
            {diff.missing && (
              <>
                <span className="commit-view__sep" aria-hidden="true">
                  ·
                </span>
                <span>{t("repo.card.status.deleted")}</span>
              </>
            )}
          </p>
          <div className="commit-view__file-head">
            {live ? (
              <button
                type="button"
                className="commit-view__path"
                title={diff.path}
                aria-label={`${t("activity.file.openAria")} ${diff.path}`}
                onClick={() => openFile(diff.path)}
              >
                {diff.path}
              </button>
            ) : (
              <span className="commit-view__path" title={diff.path}>
                {diff.path}
              </span>
            )}
            <span className="commit-view__counts">{counts}</span>
          </div>
        </header>
        {hunks.length > 0 ? (
          <DiffBody text={hunks} />
        ) : (
          <p className="file-viewer__notice">{t("viewer.diff.none")}</p>
        )}
        {diff.patchTruncated && (
          <p className="file-viewer__notice">{t("viewer.diff.truncated")}</p>
        )}
      </div>
    </div>
  );
}
