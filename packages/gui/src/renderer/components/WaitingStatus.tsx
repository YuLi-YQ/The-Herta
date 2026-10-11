import { useEffect, useState } from "react";

/** Flavor belongs only to waiting; terminal status remains factual. */
export function WaitingStatus({ startedAt, receiving = false }: { startedAt?: string; receiving?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [fallback] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const parsed = startedAt ? Date.parse(startedAt) : fallback;
  const seconds = Math.max(0, Math.floor((now - (Number.isFinite(parsed) ? parsed : fallback)) / 1000));
  return <span className="herta-waiting" data-state={receiving ? "receiving" : "waiting"}>
    <span>{receiving ? "正在接收回复" : seconds >= 20 ? "像是遇到了伽马射线暴，稍等片刻" : "消息正在跨越银河"}</span>
    <span aria-label="已等待时间"> · {seconds} 秒</span>
  </span>;
}
