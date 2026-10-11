import type {
  CommitDescription,
  CommitFileChange,
  CommitFileStatus,
} from "@herta/app-server";
import {
  repoPathInsideWorkspace,
  workspaceRelativeRepoPath,
} from "@herta/core/repo-path";
import { useSessionSelector } from "../../../hooks/useSessionSelector.js";
import type { MessageKey } from "../../../i18n/keys.js";
import { useLocale, useT } from "../../../i18n/LocaleProvider.js";
import { DiffBody } from "../../Workspace/DiffBody.js";
import { useFileViewerOpen } from "../file-viewer-context.js";
import {
  commitTotals,
  formatCommitDate,
  splitPatchByFile,
} from "./commit-patch.js";

/**
 * A commit beside the record (ADR 0059): the message, who and when, then
 * one section per file — git's status letter, the path, its line counts,
 * and the hunks in the record's own diff rendering. The review surface
 * for what a run committed: the done marker names the sha, this shows
 * what the sha is.
 *
 * A path opens the LIVE file where the viewer can read it (inside the
 * workspace, and not deleted by this commit) — spelled from the workspace
 * like the repository card's rows (ADR 0058 amendment). Facts only: no
 * revert, no cherry-pick, nothing here changes the repository.
 */
export function CommitView({
  commit,
}: {
  readonly commit: CommitDescription;
}): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const prefix = useSessionSelector((s) => s.repo?.prefix ?? "");
  const sections = splitPatchByFile(commit.patch);
  const totals = commitTotals(commit.files);
  const hidden = commit.filesTotal - commit.files.length;
  const date = formatCommitDate(commit.authoredAt, locale);
  return (
    <div className="file-viewer__body">
      <div
        className="file-viewer__scroll commit-view"
        data-testid="commit-view"
      >
        <header className="commit-view__head">
          <p className="commit-view__subject">{commit.subject}</p>
          <p className="commit-view__meta">
            <span className="commit-view__sha" title={commit.sha}>
              {commit.shortSha}
            </span>
            <span className="commit-view__sep" aria-hidden="true">
              ·
            </span>
            <span>{commit.author}</span>
            {date.length > 0 && (
              <>
                <span className="commit-view__sep" aria-hidden="true">
                  ·
                </span>
                <span>{date}</span>
              </>
            )}
            {commit.parents.length > 1 && (
              <>
                <span className="commit-view__sep" aria-hidden="true">
                  ·
                </span>
                <span>{t("viewer.commit.merge")}</span>
              </>
            )}
          </p>
          {commit.body.length > 0 && (
            <pre className="commit-view__message">{commit.body}</pre>
          )}
          <p className="commit-view__stat">
            <span>
              {t("viewer.commit.files", { n: String(commit.filesTotal) })}
            </span>
            {(totals.added > 0 || totals.deleted > 0) && (
              <span className="commit-view__totals">
                {`+${totals.added} −${totals.deleted}`}
              </span>
            )}
          </p>
        </header>
        {commit.files.map((file, i) => (
          <CommitFileSection
            key={`${file.status}:${file.path}`}
            file={file}
            hunks={sections[i]}
            prefix={prefix}
          />
        ))}
        {hidden > 0 && (
          <p className="file-viewer__notice">
            {t("viewer.commit.moreFiles", { n: String(hidden) })}
          </p>
        )}
        {commit.patchTruncated && (
          <p className="file-viewer__notice">{t("viewer.commit.truncated")}</p>
        )}
      </div>
    </div>
  );
}

const MARK: Record<CommitFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  unmerged: "U",
  other: "·",
};

const STATUS_KEY: Record<CommitFileStatus, MessageKey> = {
  added: "repo.card.status.added",
  modified: "repo.card.status.modified",
  deleted: "repo.card.status.deleted",
  renamed: "repo.card.status.renamed",
  copied: "repo.card.status.renamed",
  typechange: "repo.card.status.other",
  unmerged: "repo.card.status.conflict",
  other: "repo.card.status.other",
};

function CommitFileSection({
  file,
  hunks,
  prefix,
}: {
  readonly file: CommitFileChange;
  readonly hunks: string | undefined;
  readonly prefix: string;
}): JSX.Element {
  const t = useT();
  const openFile = useFileViewerOpen();
  const live = workspaceRelativeRepoPath(file.path, prefix);
  const clickable =
    openFile !== null &&
    file.status !== "deleted" &&
    repoPathInsideWorkspace(file.path, prefix);
  const title =
    file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path;
  const counts =
    file.added === null && file.deleted === null
      ? t("viewer.commit.binary")
      : `+${file.added ?? 0} −${file.deleted ?? 0}`;
  return (
    <section className={`commit-view__file is-${file.status}`}>
      <header className="commit-view__file-head">
        <span className="commit-view__mark" title={t(STATUS_KEY[file.status])}>
          {MARK[file.status]}
        </span>
        {clickable ? (
          <button
            type="button"
            className="commit-view__path"
            title={title}
            aria-label={`${t("activity.file.openAria")} ${live}`}
            onClick={() => openFile(live)}
          >
            {file.path}
          </button>
        ) : (
          <span className="commit-view__path" title={title}>
            {file.path}
          </span>
        )}
        <span className="commit-view__counts">{counts}</span>
      </header>
      {hunks !== undefined && hunks.length > 0 && <DiffBody text={hunks} />}
    </section>
  );
}
