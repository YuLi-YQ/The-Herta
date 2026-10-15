import { useRef, useState } from "react";
import type { ChatStorageUsage } from "../../shared/herta-chat.js";

const size = (bytes: number) => bytes === 0 ? "0 B" : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
export function ChatStorage({ usage, busy, onRefresh }: {
  usage?: ChatStorageUsage; busy: boolean; onRefresh: () => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setFailed(false);
    setRefreshing(true);
    try { setFailed(!(await onRefresh())); }
    catch { setFailed(true); }
    finally { pending.current = false; setRefreshing(false); }
  }
  return <>
    <button type="button" disabled={busy} onClick={() => { dialog.current?.showModal(); void refresh(); }}>存储空间</button>
    <dialog ref={dialog} className="herta-chat-memory" aria-label="聊天存储空间"
      onClick={e => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
      <header><strong>聊天存储空间</strong><button type="button" aria-label="关闭存储空间" onClick={() => dialog.current?.close()}>×</button></header>
      {failed && <p role="alert">暂时无法读取用量，请稍后刷新。</p>}
      {usage ? <>
        {[
          { label: "聊天记录", bytes: usage.historyBytes, limit: usage.historyLimitBytes },
          { label: "图片库", bytes: usage.images.bytes, limit: usage.images.limitBytes },
        ].map(item => <section key={item.label}>
          <strong>{item.label}</strong>
          <p>{size(item.bytes)} / {size(item.limit)} · 剩余 {size(Math.max(0, item.limit - item.bytes))}</p>
          <progress aria-label={`${item.label}用量`} value={Math.min(item.bytes, item.limit)} max={item.limit} style={{ width: "100%", accentColor: "var(--herta-accent)" }} />
          {item.bytes >= item.limit * 0.9 && <p role="status">{item.label}接近容量上限，请先备份数据。</p>}
        </section>)}
        <p>图片库保存了 {usage.images.files} 个独立图片文件，相同内容只计一份。</p>
        {usage.audit && <section aria-label="图片引用检查">
          <strong>图片引用检查</strong>
          <p>聊天记录使用 {usage.audit.current} 张 · 仅自动备份使用 {usage.audit.backupOnly} 张</p>
          {usage.audit.complete
            ? <p>本目录已检查的记录中未找到引用：{usage.audit.unreferenced} 张（{size(usage.audit.unreferencedBytes)}）</p>
            : <p role="status">部分记录或文件无法检查，暂不能判断哪些图片可清理。</p>}
          {usage.audit.missing > 0 && <p role="status">当前记录引用的 {usage.audit.missing} 张图片在图片库中缺失。</p>}
          <small>已检查 {usage.audit.checkedBackups} 份相邻自动备份。不含移到其他位置的备份，也未校验图片内容。本次只查看，不删除。</small>
        </section>}
        <small>统计时间：{new Date(usage.checkedAt).toLocaleString()}</small>
      </> : <p>{refreshing ? "正在查看存储空间…" : "尚未读取用量。"}</p>}
      <p>统计当前聊天记录文件与图片库，不含记忆和历史备份。归档聊天仍占空间；图片可能被备份引用，暂不自动清理。</p>
      <button type="button" disabled={busy || refreshing} onClick={() => void refresh()}>{refreshing ? "刷新中…" : "刷新用量"}</button>
    </dialog>
  </>;
}
