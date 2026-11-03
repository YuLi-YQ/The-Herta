import { useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { ChatStorageUsage, HertaChatAction, HertaChatSnapshot } from "../../shared/herta-chat.js";

const size = (bytes: number) => bytes === 0 ? "0 B" : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
export function ChatStorage({ usage, cleanup, busy, onRefresh, onCleanup }: {
  usage?: ChatStorageUsage; cleanup?: HertaChatSnapshot["imageCleanup"]; busy: boolean;
  onRefresh: () => Promise<boolean>; onCleanup: (action: HertaChatAction) => Promise<string | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setFailed(false);
    setRefreshing(true);
    try { setFailed(!(await onRefresh())); }
    catch { setFailed(true); }
    finally { pending.current = false; setRefreshing(false); }
  }
  async function act(action: HertaChatAction, rescan = true) {
    if (working) return;
    setWorking(true);
    setProblem(null);
    setDiscarding(null);
    try {
      const error = await onCleanup(action);
      setProblem(error);
      if (!error && rescan) await refresh();
    } finally { setWorking(false); }
  }
  const preview = cleanup?.preview && cleanup.preview.token !== dismissed ? cleanup.preview : undefined;
  const locked = busy || working || refreshing;
  return <>
    <button type="button" disabled={busy} onClick={() => { dialog.current?.showModal(); void refresh(); }}>存储空间</button>
    <dialog ref={dialog} className="herta-chat-memory" aria-label="聊天存储空间"
      onClick={e => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
      <header><strong>聊天存储空间</strong><button type="button" aria-label="关闭存储空间" onClick={() => dialog.current?.close()}><Icon name="close" /></button></header>
      {failed && <p role="alert">暂时无法读取用量，请稍后刷新。</p>}
      {problem && <p role="alert">{problem}</p>}
      {cleanup?.notice && !problem && <p role="status">{cleanup.notice}</p>}
      {usage ? <>
        {[
          { label: "聊天记录", bytes: usage.historyBytes, limit: usage.historyLimitBytes },
          { label: "图片库", bytes: usage.images.bytes, limit: usage.images.limitBytes },
        ].map(item => <section key={item.label}>
          <strong>{item.label}</strong>
          <p>{size(item.bytes)} / {size(item.limit)} · 剩余 {size(Math.max(0, item.limit - item.bytes))}</p>
          <progress aria-label={`${item.label}用量`} value={Math.min(item.bytes, item.limit)} max={item.limit} style={{ width: "100%", accentColor: "var(--herta-accent)" }} />
          {item.limit * 0.9 <= item.bytes && <p role="status">{item.label}接近容量上限，请先备份数据。</p>}
        </section>)}
        {!usage.images.invalid && <p>图片库保存了 {usage.images.files} 个独立图片文件，相同内容只计一份。</p>}
        {!!usage.images.others && <p role="status">图片库中另有 {usage.images.others} 个项目不是图片文件（例如文件夹），没有计入用量，也不会被清理或删除。</p>}
        {usage.images.invalid && <p role="alert">图片库的位置不是普通文件夹（可能是同名文件，或文件夹移到别处后留下的链接）。为安全起见不跟随链接，所以聊天图片暂时无法保存或显示，用量也无法统计；它不会被删除或改动。</p>}
        {usage.audit && <section aria-label="图片引用检查">
          <strong>图片引用检查</strong>
          <p>聊天记录使用 {usage.audit.current} 张 · 仅自动备份使用 {usage.audit.backupOnly} 张</p>
          {usage.audit.complete
            ? <p>本目录已检查的记录中未找到引用：{usage.audit.unreferenced} 张（{size(usage.audit.unreferencedBytes)}）</p>
            : <p role="status">部分记录或文件无法检查，暂不能判断哪些图片可清理。</p>}
          {usage.audit.missing > 0 && <p role="status">当前记录引用的 {usage.audit.missing} 张图片在图片库中缺失。</p>}
          <small>已检查 {usage.audit.checkedBackups} 份相邻自动备份。不含移到其他位置的备份，也未校验图片内容。</small>
          {usage.audit.complete && usage.audit.unreferenced > 0 && !preview &&
            <button type="button" disabled={locked} onClick={() => void act({ type: "image-preview" }, false)}>预览可清理图片</button>}
        </section>}
        {preview && <section aria-label="清理预览">
          <strong>清理预览</strong>
          <p>将移入隔离区：{preview.files} 张（{size(preview.bytes)}）。只包含当前记录和相邻自动备份都没有引用的图片。</p>
          <small>先移入隔离区，随时可以恢复；执行前会再检查一次引用。</small>
          <div className="herta-chat-actions">
            <button type="button" disabled={locked} onClick={() => void act({ type: "image-isolate", token: preview.token })}>移入隔离区</button>
            <button type="button" disabled={working} onClick={() => setDismissed(preview.token)}>取消</button>
          </div>
        </section>}
        {!!usage.quarantine?.length && <section aria-label="图片隔离区">
          <strong>隔离区</strong>
          {usage.quarantine.map(batch => <div key={batch.id}>
            <p>{new Date(batch.at).toLocaleString()} · {batch.files} 张 · {size(batch.bytes)}</p>
            {discarding === batch.id
              ? <>
                <p role="status">永久删除后无法恢复。</p>
                <div className="herta-chat-actions">
                  <button type="button" disabled={locked} onClick={() => void act({ type: "image-discard", id: batch.id })}>确认永久删除</button>
                  <button type="button" disabled={working} onClick={() => setDiscarding(null)}>取消</button>
                </div>
              </>
              : <div className="herta-chat-actions">
                <button type="button" disabled={locked} onClick={() => void act({ type: "image-restore", id: batch.id })}>恢复</button>
                <button type="button" disabled={locked} onClick={() => setDiscarding(batch.id)}>永久删除</button>
              </div>}
          </div>)}
        </section>}
        <small>统计时间：{new Date(usage.checkedAt).toLocaleString()}</small>
      </> : <p>{refreshing ? "正在查看存储空间…" : "尚未读取用量。"}</p>}
      <p>统计聊天记录与图片库，不含记忆和备份；回收区的聊天也占空间。清理图片时先移入隔离区，可以恢复。</p>
      <button type="button" disabled={busy || refreshing} onClick={() => void refresh()}>{refreshing ? "刷新中…" : "刷新用量"}</button>
    </dialog>
  </>;
}
