import { render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { ModeTabs } from "./ModeTabs.js";
import { initializeAppearance, setAppearance } from "../lib/appearance.js";
afterEach(()=>{localStorage.clear();delete document.documentElement.dataset.appearance;});
function Harness(){const [chat,setChat]=useState(false);return <><ModeTabs chatOpen={chat} selectMode={setChat}/><input aria-label="draft" defaultValue="保留草稿"/><output>{chat?"chat":"workbench"}</output></>;}
it("switches tabs by keyboard and rolls back appearance without losing selection or draft",()=>{
 initializeAppearance();render(<Harness/>);
 const first=screen.getByRole("tab",{name:"工作台"});
 expect(first.closest("nav")).toHaveClass("u039");
 fireEvent.keyDown(first,{key:"ArrowRight"});
 expect(screen.getByRole("tab",{name:"与黑塔聊天"})).toHaveAttribute("aria-selected","true");
 expect(document.activeElement).toBe(screen.getByRole("tab",{name:"与黑塔聊天"}));
 act(()=>setAppearance("classic"));
 expect(first.closest("nav")).toHaveClass("herta-mode-tabs");
 expect(screen.getByRole("tab",{name:"与黑塔聊天"})).toHaveAttribute("aria-selected","true");
 expect(screen.getByLabelText("draft")).toHaveValue("保留草稿");
 initializeAppearance();expect(document.documentElement.dataset.appearance).toBe("classic");
 act(()=>setAppearance("observatory"));expect(first.closest("nav")).toHaveClass("u039");
 fireEvent.keyDown(screen.getByRole("tab",{name:"与黑塔聊天"}),{key:"Home"});
 expect(first).toHaveAttribute("aria-selected","true");
});
