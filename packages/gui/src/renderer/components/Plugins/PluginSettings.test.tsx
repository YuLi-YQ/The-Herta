import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect,it,vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { PluginSettings } from "./PluginSettings.js";
import type { PluginRequest,PluginReply } from "../../../shared/prompt-plugins.js";
it("previews before install and releases cancelled previews without mutations",async()=>{
 const bridge=createMockHertaBridge().bridge;const snapshot={revision:0,items:[]};bridge.promptPlugins=vi.fn(async(input:PluginRequest):Promise<PluginReply>=>({ok:true,snapshot,...(input.kind==="preview"?{preview:{id:"token",identical:false,manifest:{schemaVersion:1,id:"local.sample",name:"示例插件",version:"1.0.0",description:"示例说明",actions:[{id:"act",title:"动作",scope:"both",prompt:"hello",inputs:[]}]}}}:{})}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PluginSettings/></HertaBridgeProvider>);await screen.findByText(/尚无插件/);
 fireEvent.click(screen.getByRole("button",{name:"从文件安装 / 更新"}));await screen.findByRole("button",{name:"安装并启用"});expect(bridge.promptPlugins).not.toHaveBeenCalledWith(expect.objectContaining({kind:"install"}));
 fireEvent.click(screen.getByRole("button",{name:"取消"}));await waitFor(()=>expect(bridge.promptPlugins).toHaveBeenCalledWith({kind:"discard",previewId:"token"}));
});
it("asks for confirmation before starting over from a damaged record",async()=>{
 const bridge=createMockHertaBridge().bridge;bridge.promptPlugins=vi.fn(async(input:PluginRequest):Promise<PluginReply>=>({ok:true,snapshot:input.kind==="reset"?{revision:1,items:[]}:{revision:0,items:[],damaged:true}}));
 renderWithLocale(<HertaBridgeProvider bridge={bridge}><PluginSettings/></HertaBridgeProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"另存损坏记录并重新开始"}));expect(bridge.promptPlugins).not.toHaveBeenCalledWith({kind:"reset"});
 fireEvent.click(screen.getByRole("button",{name:"确认重新开始"}));await screen.findByText(/尚无插件/);expect(bridge.promptPlugins).toHaveBeenCalledWith({kind:"reset"});
});
