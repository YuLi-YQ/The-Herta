import { useEffect, useState } from "react";
import type { ExecutablePluginPreview } from "../../../shared/executable-plugin-management.js";
import { RoundFileView } from "../RoundReader.js";

const CHANGE = { added: "新增", modified: "修改", removed: "移除", unchanged: "未变" } as const;

/** Only immutable host-computed snapshots are rendered; this never reads disk. */
export function PluginInstallDiff({ preview }: { preview: ExecutablePluginPreview }) {
  const [path, setPath] = useState("manifest.json");
  useEffect(() => setPath("manifest.json"), [preview.id]);
  const selected = preview.changes.find(file => file.path === path) ?? preview.changes[0];
  const changed = preview.changes.filter(file => file.change !== "unchanged");
  return <details open className="plugin-install-diff">
    <summary>代码与权限变化 · {changed.length} 项</summary>
    <p className="executable-plugin-muted">{preview.baseContentHash ? "对照当前已安装版本；插件清单包含权限和操作变化。" : "首次安装；下方展示将加入的完整插件内容。"}</p>
    {selected ? <>
      <label className="plugin-install-file">查看文件
        <select value={selected.path} onChange={event => setPath(event.target.value)}>
          {preview.changes.map(file => <option key={file.path} value={file.path}>{file.path} · {CHANGE[file.change]} +{file.additions} −{file.deletions}</option>)}
        </select>
      </label>
      <div className="plugin-install-reader">
        <RoundFileView key={`${preview.id}:${selected.path}`} content={{
          roundId: preview.id, fileId: selected.path, path: selected.path,
          before: selected.before, after: selected.after, diff: selected.diff,
          language: selected.kind === "manifest" ? "json" : "javascript",
          sourceLabel: "安装候选的冻结差异 · 尚未安装",
        }} />
      </div>
    </> : <p className="executable-plugin-error">未取得可核对的安装差异，请重新预览。</p>}
  </details>;
}
