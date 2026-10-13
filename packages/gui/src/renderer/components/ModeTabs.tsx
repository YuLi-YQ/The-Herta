// Lucian UX/UI Prompt #039 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#039
import { useLayoutEffect, useRef } from "react";
import { useAppearance } from "../lib/appearance.js";
import "../styles/lucian-mode-tabs.css";

/** #039's pill and keyboard interaction, connected to the two existing persistent panels. */
export function ModeTabs({ chatOpen, selectMode }: { chatOpen: boolean; selectMode: (chat: boolean) => void }) {
  const style = useAppearance(), root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (style !== "observatory") return;
    const element = root.current!;
    const move = () => {
      const tab = element.querySelector<HTMLElement>('[aria-selected="true"]');
      if (tab) { element.style.setProperty("--x", `${tab.offsetLeft}px`); element.style.setProperty("--w", `${tab.offsetWidth}px`); }
    };
    move();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(move);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [chatOpen, style]);
  return <nav ref={root} className={style === "observatory" ? "ux u039 u039-tabs" : "herta-mode-tabs"} role="tablist" aria-label="工作模式">
    {style === "observatory" && <span className="u039-pill" aria-hidden="true" />}
    {[false, true].map(chat => <button key={String(chat)} type="button" role="tab"
      className={style === "observatory" ? "u039-tab" : undefined}
      id={chat ? "herta-chat-tab" : "herta-workbench-tab"}
      aria-selected={chatOpen === chat} aria-controls={chat ? "herta-chat-panel" : "herta-workbench-panel"}
      tabIndex={chatOpen === chat ? 0 : -1} onClick={() => selectMode(chat)}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? false : event.key === "End" ? true : !chat;
        selectMode(next);
        document.getElementById(next ? "herta-chat-tab" : "herta-workbench-tab")?.focus();
      }}>{chat ? "与黑塔聊天" : "工作台"}</button>)}
  </nav>;
}
