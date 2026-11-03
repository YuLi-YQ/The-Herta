import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatModelPicker } from "./ChatModelPicker.js";

const models = [
  { key: "first", providerId: "p", providerName: "服务一", modelId: "model-one", label: "model-one · 服务一", efforts: ["none", "high"] },
  { key: "second", providerId: "q", providerName: "服务二", modelId: "model-two", label: "model-two · 服务二", efforts: [] },
] as const;
const props = () => ({
  target: "chat-a",
  shown: true,
  disabled: false,
  models,
  selected: "first",
  effort: "high",
  budget: 16384,
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onBudget: vi.fn(),
  onManage: vi.fn(),
});
const trigger = () => screen.getByRole("button", { name: "聊天模型与回复设置" });
const panel = () => screen.queryByRole("dialog", { name: "聊天模型与回复设置" });

it("keeps only one trigger in the composer and exposes real choices on open", () => {
  const p = props();
  render(<ChatModelPicker {...p} />);
  expect(trigger()).toHaveTextContent("model-one · 深度");
  expect(trigger()).toHaveAttribute("title", "model-one · 服务一");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(panel()).not.toBeInTheDocument();
  fireEvent.click(trigger());
  expect(panel()).toBeInTheDocument();
  expect(screen.getByRole("button", { name: models[0].label })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: models[1].label }));
  expect(p.onModel).toHaveBeenCalledWith("second");
  expect(p.onManage).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "聊天思考强度" })).toHaveValue("high");
  fireEvent.change(screen.getByRole("combobox", { name: "聊天思考强度" }), { target: { value: "none" } });
  fireEvent.change(screen.getByRole("combobox", { name: "回复额度" }), { target: { value: "32768" } });
  expect(p.onEffort).toHaveBeenCalledWith("none");
  expect(p.onBudget).toHaveBeenCalledWith(32768);
});

it("focuses the selected option, ignores composing Escape and restores focus on dismissal", () => {
  render(<ChatModelPicker {...props()} selected="second" effort="" />);
  fireEvent.click(trigger());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: models[1].label }));
  expect(screen.queryByRole("combobox", { name: "聊天思考强度" })).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape", isComposing: true });
  fireEvent.keyDown(document, { key: "Escape", keyCode: 229 });
  expect(panel()).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(panel()).not.toBeInTheDocument();
  expect(document.activeElement).toBe(trigger());
});

it("closes on outside pointer or focus without stealing the outside control's focus", () => {
  render(<><ChatModelPicker {...props()} /><button type="button">其他操作</button></>);
  const outside = screen.getByRole("button", { name: "其他操作" });
  fireEvent.click(trigger());
  fireEvent.pointerDown(outside);
  act(() => outside.focus());
  expect(panel()).not.toBeInTheDocument();
  expect(document.activeElement).toBe(outside);
  fireEvent.click(trigger());
  act(() => outside.focus());
  expect(panel()).not.toBeInTheDocument();
  expect(document.activeElement).toBe(outside);
});

it.each(["target", "hidden", "disabled"])("dismisses the old controls when %s changes", (kind) => {
  const p = props();
  const view = render(<ChatModelPicker {...p} />);
  fireEvent.click(trigger());
  const oldOption = screen.getByRole("button", { name: models[1].label });
  const changed = kind === "target" ? { target: "chat-b" } : kind === "hidden" ? { shown: false } : { disabled: true };
  view.rerender(<ChatModelPicker {...p} {...changed} />);
  expect(panel()).not.toBeInTheDocument();
  fireEvent.click(oldOption);
  expect(p.onModel).not.toHaveBeenCalled();
  view.rerender(<ChatModelPicker {...p} />);
  expect(panel()).not.toBeInTheDocument();
  expect(p.onBudget).not.toHaveBeenCalled();
});

it("disables an unavailable chat and keeps connection management separate from selection", () => {
  const p = props();
  const view = render(<ChatModelPicker {...p} target={null} />);
  expect(trigger()).toBeDisabled();
  fireEvent.click(trigger());
  expect(panel()).not.toBeInTheDocument();
  view.rerender(<ChatModelPicker {...p} models={[]} selected="" />);
  fireEvent.click(trigger());
  expect(screen.getByText("暂无已验证的聊天模型。")).toBeInTheDocument();
  const manage = screen.getByRole("button", { name: "管理连接与模型" });
  expect(document.activeElement).toBe(manage);
  fireEvent.click(manage);
  expect(p.onManage).toHaveBeenCalledTimes(1);
  expect(panel()).not.toBeInTheDocument();
  expect(p.onModel).not.toHaveBeenCalled();
});
