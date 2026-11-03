import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { PromptActionPicker } from "./PromptActionPicker.js";
import { PluginDeliverablesPanel } from "./PluginDeliverablesPanel.js";
import { useState } from "react";
import type { PluginReply, PluginRequest } from "../../../shared/prompt-plugins.js";
const snapshot={revision:1,items:[{enabled:true,contentHash:"hash",installedAt:"today",updatedAt:"today",manifest:{schemaVersion:1 as const,id:"local.test",name:"测试包",version:"1.0.0",description:"",actions:[{id:"review",title:"检查",scope:"both" as const,prompt:"检查 {{request}}",inputs:[{id:"request",label:"内容",type:"text" as const,required:true}]}]}}]};

it("opens persisted files outside the menu; window blur cannot unmount that owner panel",async()=>{
 const bridge=createMockHertaBridge().bridge;
 bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot:{revision:0,items:[]}}));
 bridge.executablePlugins=vi.fn(async()=>({ok:true as const,outputs:{artifacts:[],proposals:[],damagedArtifacts:0,damagedProposals:0}}));
 function Owner(){const[open,setOpen]=useState(false);return <><PromptActionPicker scope="workbench" target="draft-key" executionTarget="session-real" draft="" onInsert={vi.fn()} onOpenOutputs={()=>setOpen(true)}/><PluginDeliverablesPanel scope="workbench" target="session-real" open={open} draftRevision={1} onClose={()=>setOpen(false)}/></>;}
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><Owner/></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));
 fireEvent.click(await screen.findByRole("button",{name:/插件文件/}));
 await screen.findByText("这个任务还没有插件文件。");
 expect(screen.queryByLabelText("快捷操作")).toBeNull();fireEvent.blur(window);
 expect(screen.getByLabelText("插件文件")).toBeTruthy();
 expect(bridge.executablePlugins).toHaveBeenCalledWith({kind:"outputs-list",scope:"workbench",target:"session-real"});
 expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({kind:"run"}));
});
it("removes empty prompt search and copy while keeping executable entry and builtins",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot:{revision:0,items:[]}}));
 bridge.executablePlugins=vi.fn(async()=>({ok:true as const}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" onInsert={vi.fn()}/></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));
 await waitFor(()=>expect(screen.queryByLabelText("查找操作")).toBeNull());
 expect(screen.queryByText(/暂无提示词动作/)).toBeNull();expect(screen.getByRole("button",{name:/运行插件/})).toBeTruthy();expect(screen.getByRole("group",{name:"常用"})).toBeTruthy();
});
async function choose(){fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));fireEvent.click(await screen.findByRole("button",{name:/检查/}));fireEvent.change(screen.getByLabelText("内容 *"),{target:{value:"问题"}});}
it("appends to draft without sending and restores the draft through the owner",async()=>{
 const insert=vi.fn(),bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async (input:PluginRequest):Promise<PluginReply>=>input.kind==="prepare"?{ok:true,snapshot,text:"检查 问题"}:{ok:true,snapshot});
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="已有" onInsert={insert}/></HertaBridgeProvider>);
 await choose();fireEvent.click(screen.getByRole("button",{name:"插入草稿"}));await waitFor(()=>expect(insert).toHaveBeenCalledWith("已有\n\n检查 问题"));expect(screen.queryByLabelText("快捷操作")).toBeNull();
});
it("says when a search has no matching action",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="workbench" target="one" draft="" onInsert={vi.fn()}/></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));await screen.findByRole("button",{name:/检查/});
 fireEvent.change(screen.getByLabelText("查找操作"),{target:{value:"部署"}});expect(screen.getByText("没有匹配的操作，请换个关键词。")).toBeTruthy();expect(screen.queryByText(/暂无提示词动作/)).toBeNull();
});
it("ignores a late prepared result after changing conversation",async()=>{
 let finish!:(r:PluginReply)=>void;const insert=vi.fn(),bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn((input:PluginRequest):Promise<PluginReply>=>input.kind==="prepare"?new Promise<PluginReply>(r=>{finish=r;}):Promise.resolve({ok:true,snapshot}));
 const wrap=(target:string)=><HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target={target} draft="" onInsert={insert}/></HertaBridgeProvider>;
 const {rerender}=renderWithLocale(wrap("one"));await choose();fireEvent.click(screen.getByRole("button",{name:"插入草稿"}));rerender(wrap("two"));finish({ok:true,snapshot,text:"检查 问题"});await waitFor(()=>expect(screen.queryByLabelText("快捷操作")).toBeNull());expect(insert).not.toHaveBeenCalled();
});
it("keeps edits made while preparing a prompt",async()=>{
 let finish!:(r:PluginReply)=>void;const insert=vi.fn(),bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn((input:PluginRequest):Promise<PluginReply>=>input.kind==="prepare"?new Promise<PluginReply>(r=>{finish=r;}):Promise.resolve({ok:true,snapshot}));
 const wrap=(draft:string)=><HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft={draft} onInsert={insert}/></HertaBridgeProvider>;
 const {rerender}=renderWithLocale(wrap("old"));await choose();fireEvent.click(screen.getByRole("button",{name:"插入草稿"}));rerender(wrap("new"));finish({ok:true,snapshot,text:"检查 问题"});await screen.findByText("草稿已变化，请重新确认后插入。");expect(insert).not.toHaveBeenCalled();
});
it("keeps the picker open while an IME's Escape cancels a candidate (R44)",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" onInsert={vi.fn()}/></HertaBridgeProvider>);
 await choose();
 fireEvent.keyDown(document,{key:"Escape",isComposing:true});fireEvent.keyDown(document,{key:"Escape",keyCode:229});
 expect(screen.getByLabelText("快捷操作")).toBeTruthy();expect(screen.getByLabelText("内容 *")).toHaveValue("问题");
 fireEvent.keyDown(document,{key:"Escape"});expect(screen.queryByLabelText("快捷操作")).toBeNull();
});
it("keeps keyboard focus inside the picker when opening, choosing and going back (R64)",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" onInsert={vi.fn()}/></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));
 const option=await screen.findByRole("button",{name:/检查/});
 expect(document.activeElement).toBe(screen.getByLabelText("查找操作"));
 option.focus();fireEvent.click(option);
 expect(document.activeElement).toBe(screen.getByLabelText("内容 *"));
 fireEvent.click(screen.getByRole("button",{name:"返回列表"}));
 expect(document.activeElement).toBe(screen.getByLabelText("查找操作"));
 expect(screen.getByLabelText("快捷操作")).toBeTruthy();
});
it("gives the composer's actions the same reasons as the / menu, from the shared registry (R123)",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot}));
 // Files are being read: HertaChat disables its file input and says so through `state`.
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><div className="herta-chat-composer"><PromptActionPicker scope="chat" target="one" draft="" state={{reading:true}} onInsert={vi.fn()}/><input type="file" aria-label="附加文件" disabled/><button type="button" className="herta-chat-model" aria-label="聊天模型与回复设置">m</button></div></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));
 const common=await screen.findByRole("group",{name:"常用"});
 const attach=within(common).getByRole("button",{name:/附加文件/});
 expect(attach).toBeDisabled();expect(attach).toHaveTextContent("正在读取文件，读完后再添加");
 expect(within(common).getByRole("button",{name:/选择模型/})).toHaveTextContent("本聊天使用的模型");
});
it("searches the composer's actions with the same matcher as the / menu (R123)",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="workbench" target="one" draft="" onInsert={vi.fn()}/></HertaBridgeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"快捷操作"}));await screen.findByRole("button",{name:/检查/});
 fireEvent.change(screen.getByLabelText("查找操作"),{target:{value:"moxing"}});
 expect(within(screen.getByRole("group",{name:"常用"})).getAllByRole("button").map(b=>b.firstChild?.textContent)).toEqual(["选择模型"]);
 expect(screen.queryByRole("button",{name:/检查/})).toBeNull();expect(screen.queryByText("没有匹配的操作，请换个关键词。")).toBeNull();
 // A plugin's name finds its actions, as / does.
 fireEvent.change(screen.getByLabelText("查找操作"),{target:{value:"测试包"}});
 expect(screen.queryByRole("group",{name:"常用"})).toBeNull();expect(screen.getByRole("button",{name:/检查/})).toBeTruthy();
});
it("says so when a prompt action chosen from / was disabled or removed meanwhile (R123)",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async():Promise<PluginReply>=>({ok:true,snapshot:{...snapshot,items:[]}}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" request={{pluginId:"local.test",actionId:"review",title:"检查",nonce:1}} onInsert={vi.fn()}/></HertaBridgeProvider>);
 expect(await screen.findByRole("alert")).toHaveTextContent("无法执行“检查”：已停用或已删除，请重新选择");
 // The list stays open to choose again; nothing was inserted.
 expect(screen.getByLabelText("查找操作")).toBeTruthy();expect(screen.queryByRole("heading",{name:"检查"})).toBeNull();
});
