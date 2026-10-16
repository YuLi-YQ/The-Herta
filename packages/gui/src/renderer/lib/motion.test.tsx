import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { initializeMotion, motionPreference, setMotionPreference, useMotionPreference } from "./motion.js";
import { initializeAppearance, setAppearance } from "./appearance.js";
import { ModeTabs } from "../components/ModeTabs.js";
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); delete document.documentElement.dataset.motion; delete document.documentElement.dataset.appearance; });
it("persists motion separately from appearance and leaves the current setting intact when storage fails", () => {
 initializeAppearance(); initializeMotion();
 expect(motionPreference()).toBe("system");
 setMotionPreference("off"); initializeMotion();
 expect(document.documentElement.dataset.motion).toBe("off");
 setAppearance("classic"); expect(motionPreference()).toBe("off");
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("unavailable");});
 expect(()=>setMotionPreference("system")).toThrow();
 expect(document.documentElement.dataset.motion).toBe("off");
 expect(motionPreference()).toBe("off");
});
it("turns motion off safely when reading preferences is unavailable", () => {
 vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw new Error("unavailable");});
 initializeMotion(); expect(document.documentElement.dataset.motion).toBe("off");
});
it("updates subscribers without resetting mode selection or drafts", () => {
 function Harness(){const [chat,setChat]=useState(false);const preference=useMotionPreference();return <><ModeTabs chatOpen={chat} selectMode={setChat}/><input aria-label="draft" defaultValue="保留草稿"/><output>{preference}</output></>;}
 initializeAppearance();initializeMotion();render(<Harness/>);
 fireEvent.keyDown(screen.getByRole("tab",{name:"工作台"}),{key:"End"});
 act(()=>setMotionPreference("off"));
 expect(screen.getByText("off")).toBeInTheDocument();
 expect(screen.getByRole("tab",{name:"与黑塔聊天"})).toHaveAttribute("aria-selected","true");
 expect(screen.getByLabelText("draft")).toHaveValue("保留草稿");
});
