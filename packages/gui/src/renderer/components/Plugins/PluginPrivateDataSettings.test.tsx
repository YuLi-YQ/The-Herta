import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ExecutablePluginReply, ExecutablePluginRequest } from "../../../shared/executable-plugin-management.js";
import type { PrivatePluginDataPreview } from "../../../shared/plugin-private-data.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginPrivateDataSettings } from "./PluginPrivateDataSettings.js";

const preview: PrivatePluginDataPreview={id:"test-token",pluginId:"example.private",action:"restore",hostRevision:1,expiresAt:"2026-11-02T12:00:00Z",current:{state:"valid",bytes:128,keys:2},backup:{state:"valid",bytes:64,keys:1,savedAt:"2026-11-02T10:00:00Z"},canConfirm:true};
const props={pluginId:preview.pluginId,hostRevision:1,disabled:false,onChanged:vi.fn()};
it("R143 private UI shows metadata without changing data until the explicit confirmation",async()=>{
  const request=vi.fn(async(input:ExecutablePluginRequest):Promise<ExecutablePluginReply>=>input.kind==="private-data-preview"?{ok:true,privateDataPreview:preview}:input.kind==="private-data-confirm"?{ok:true,privateDataResult:{pluginId:preview.pluginId,action:"restore",keys:1,bytes:64,archived:true}}:{ok:true});
  const changed=vi.fn();renderWithLocale(<PluginPrivateDataSettings {...props} request={request} onChanged={changed}/>);
  expect(request).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"资料与备份"}));
  const confirm=await screen.findByRole("button",{name:"确认恢复备份"});
  expect(screen.getByText("2 项 · 128 B")).toBeVisible();expect(screen.getByRole("region",{name:"插件资料与备份"})).toHaveFocus();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({kind:"private-data-confirm"}));
  fireEvent.click(confirm);await screen.findByText("资料已恢复。原资料已另存。");expect(changed).toHaveBeenCalledOnce();
});
it("R143 private UI disables unavailable backups and requires a fresh reset preview before rebuilding",async()=>{
  const request=vi.fn(async(input:ExecutablePluginRequest):Promise<ExecutablePluginReply>=>input.kind==="private-data-preview"?{ok:true,privateDataPreview:{...preview,action:input.action,backup:{state:"missing",bytes:0},canConfirm:input.action==="reset"}}:{ok:true});
  renderWithLocale(<PluginPrivateDataSettings {...props} request={request}/>);
  fireEvent.click(screen.getByRole("button",{name:"资料与备份"}));expect(await screen.findByRole("button",{name:"确认恢复备份"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"重建空白资料…"}));expect(await screen.findByRole("button",{name:"确认重建资料"})).not.toBeDisabled();
  expect(screen.getByText(/先另存原资料和备份/)).toBeVisible();
  expect(request).toHaveBeenCalledWith({kind:"private-data-preview",pluginId:preview.pluginId,action:"reset",hostRevision:1});
  fireEvent.click(screen.getByRole("button",{name:"关闭资料预览"}));
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({kind:"private-data-confirm"}));
});
it("R143 private UI discards late previews after revision changes or unmount",async()=>{
  let finish!:(reply:ExecutablePluginReply)=>void;
  const request=vi.fn((input:ExecutablePluginRequest):Promise<ExecutablePluginReply>=>input.kind==="private-data-preview"?new Promise(resolve=>{finish=resolve;}):Promise.resolve({ok:true}));
  const {rerender,unmount}=renderWithLocale(<PluginPrivateDataSettings {...props} request={request}/>);
  fireEvent.click(screen.getByRole("button",{name:"资料与备份"}));
  rerender(<PluginPrivateDataSettings {...props} hostRevision={2} request={request}/>);
  await act(async()=>finish({ok:true,privateDataPreview:preview}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith({kind:"private-data-discard",previewId:preview.id}));
  expect(screen.queryByRole("button",{name:"确认恢复备份"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"资料与备份"}));unmount();
  await act(async()=>finish({ok:true,privateDataPreview:{...preview,id:"late",hostRevision:2}}));
  expect(request).toHaveBeenCalledWith({kind:"private-data-discard",previewId:"late"});
});
