import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PluginNetworkConfig, PluginNetworkSettingsSnapshot } from "../../../shared/plugin-network-settings.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginNetworkSettings } from "./PluginNetworkSettings.js";

type Request = NonNullable<HertaBridge["executablePlugins"]>;
const direct: PluginNetworkConfig = { mode: "direct", proxyUrl: "", resolver: "system", dohUrl: "", dohBootstrapAddress: "" };
const proxy: PluginNetworkConfig = { mode: "proxy", proxyUrl: "http://127.0.0.1:7890", resolver: "doh", dohUrl: "https://resolver.example/dns-query", dohBootstrapAddress: "1.1.1.1" };
async function open() {
  fireEvent.click(screen.getByText("插件联网"));
  await screen.findByLabelText("连接方式");
}

it("R147 network form stays collapsed and direct by default, conditionally exposes fields and saves only on explicit confirmation", async () => {
  const request = vi.fn<Request>(async input => input.kind === "network-settings-set" ? { ok: true, networkSettings: { revision: 1, config: input.config } }
    : { ok: true, networkSettings: { revision: 0, config: direct } });
  renderWithLocale(<PluginNetworkSettings request={request} />);
  await screen.findByText("直连 · 系统解析"); expect(screen.getByText("插件联网").closest("details")).not.toHaveAttribute("open");
  await open(); expect(screen.getByLabelText("连接方式")).toHaveValue("direct"); expect(screen.getByLabelText("域名解析")).toHaveValue("system");
  expect(screen.queryByLabelText("代理地址（数字 IP）")).toBeNull(); expect(screen.queryByLabelText("HTTPS 解析地址")).toBeNull();
  fireEvent.change(screen.getByLabelText("连接方式"), { target: { value: "proxy" } });
  const address = screen.getByLabelText("代理地址（数字 IP）"); expect(address).toHaveValue(""); expect(address).toHaveAttribute("placeholder", "http://127.0.0.1:7890");
  address.focus(); expect(address).toHaveFocus(); fireEvent.change(address, { target: { value: proxy.proxyUrl } });
  expect(request).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(request).toHaveBeenCalledTimes(1);
  await open(); expect(screen.getByLabelText("连接方式")).toHaveValue("direct");
  fireEvent.change(screen.getByLabelText("连接方式"), { target: { value: "proxy" } }); fireEvent.change(screen.getByLabelText("代理地址（数字 IP）"), { target: { value: proxy.proxyUrl } });
  fireEvent.change(screen.getByLabelText("域名解析"), { target: { value: "doh" } }); expect(screen.getByText(/所请求的域名会发送给你指定的解析服务/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("HTTPS 解析地址"), { target: { value: proxy.dohUrl } }); fireEvent.change(screen.getByLabelText("解析服务的公网 IP"), { target: { value: proxy.dohBootstrapAddress } });
  expect(request).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole("button", { name: "保存插件联网设置" }));
  await screen.findByText("插件联网设置已保存。"); expect(request).toHaveBeenLastCalledWith({ kind: "network-settings-set", expectedRevision: 0, config: proxy });
  expect(screen.getByRole("button", { name: "保存插件联网设置" })).toBeDisabled();
});

it("R147 network load errors remain visible and revision conflicts preserve input until an explicit discard and reload", async () => {
  const initial: PluginNetworkSettingsSnapshot = { revision: 7, config: direct, loadError: "旧配置无法读取，原记录保留。" };
  const latest: PluginNetworkSettingsSnapshot = { revision: 8, config: { ...direct, mode: "proxy", proxyUrl: "http://127.0.0.1:8888" } };
  let reads = 0;
  const request = vi.fn<Request>(async input => input.kind === "network-settings-set" ? { ok: false, message: "设置已变化，请重新读取后再保存。" }
    : { ok: true, networkSettings: ++reads === 1 ? initial : latest });
  renderWithLocale(<PluginNetworkSettings request={request} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(initial.loadError!); expect(screen.getByText("插件联网").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("配置待处理")).toBeVisible(); expect(screen.queryByText("直连 · 系统解析")).toBeNull();
  await open(); fireEvent.change(screen.getByLabelText("连接方式"), { target: { value: "proxy" } }); fireEvent.change(screen.getByLabelText("代理地址（数字 IP）"), { target: { value: proxy.proxyUrl } });
  fireEvent.click(screen.getByRole("button", { name: "保存插件联网设置" })); await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("设置已变化"));
  expect(screen.getByLabelText("代理地址（数字 IP）")).toHaveValue(proxy.proxyUrl); expect(reads).toBe(1);
  expect(request).toHaveBeenLastCalledWith({ kind: "network-settings-set", expectedRevision: 7, config: { ...direct, mode: "proxy", proxyUrl: proxy.proxyUrl } });
  expect(screen.queryByText("插件联网设置已保存。")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并放弃编辑" }));
  await waitFor(() => expect(screen.getByLabelText("代理地址（数字 IP）")).toHaveValue(latest.config.proxyUrl));
  expect(reads).toBe(2); expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByRole("button", { name: "保存插件联网设置" })).toBeDisabled();
  expect(request.mock.calls.filter(([input]) => input.kind === "network-settings-set")).toHaveLength(1);
});
