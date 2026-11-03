import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ bridge: { readHertaChatImage: vi.fn() } }));
vi.mock("../context/HertaBridgeContext.js", () => ({ useHertaBridge: () => mock }));
import { ChatMessageAttachments } from "./ChatAttachmentPreview.js";
const image = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };

/** A stand-in for the browser's observer: the test says when the thumbnail comes into view. */
const observed: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
class FakeObserver {
  entry: { callback: IntersectionObserverCallback; disconnected: boolean };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, disconnected: false };
    observed.push(this.entry);
  }
  observe() {}
  disconnect() { this.entry.disconnected = true; }
}
const intoView = () => act(async () => {
  for (const o of observed) if (!o.disconnected) o.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
});
afterEach(() => { vi.unstubAllGlobals(); observed.length = 0; mock.bridge.readHertaChatImage.mockReset(); });

it("reads a history picture only once it nears view, and drops a result that lands after unmount (R78)", async () => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  mock.bridge.readHertaChatImage.mockResolvedValue(image);
  render(<ChatMessageAttachments attachments={[{ name: "x.png", text: "", imageDeferred: true }]} chatId="c" messageId="m" />);
  const thumb = screen.getByRole("button", { name: "查看图片 x.png" });
  expect(thumb).toBeDisabled();
  expect(mock.bridge.readHertaChatImage).not.toHaveBeenCalled();
  await intoView();
  await waitFor(() => expect(thumb.querySelector("img")).toHaveAttribute("src", `data:image/png;base64,${image.data}`));
  expect(mock.bridge.readHertaChatImage).toHaveBeenCalledTimes(1);
  expect(mock.bridge.readHertaChatImage).toHaveBeenLastCalledWith("c", "m", 0);

  let finish!: (value: typeof image) => void;
  mock.bridge.readHertaChatImage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const late = render(<ChatMessageAttachments attachments={[{ name: "y.png", text: "", imageDeferred: true }]} chatId="c" messageId="n" />);
  await intoView();
  late.unmount();
  await act(async () => finish(image));
  expect(screen.queryByRole("button", { name: "查看图片 y.png" })).toBeNull();
});

it("opens a picture in the shared viewer and returns focus to its thumbnail (R44, R78)", async () => {
  const { renderWithLocale } = await import("../i18n/test-util.js");
  renderWithLocale(<ChatMessageAttachments attachments={[{ name: "y.png", text: "", image: { ...image, mimeType: "image/png" } }]} chatId="c" messageId="m" />, { locale: "zh" });
  const trigger = screen.getByRole("button", { name: "查看图片 y.png" });
  fireEvent.click(trigger);
  const viewer = screen.getByTestId("lightbox");
  expect(viewer).toHaveAccessibleName("y.png");
  expect(viewer.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByTestId("lightbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("says a missing picture is missing instead of offering to open it (R78)", () => {
  render(<ChatMessageAttachments attachments={[{ name: "gone.png", text: "", imageMissing: true }]} chatId="c" messageId="m" />);
  const thumb = screen.getByRole("button", { name: "gone.png：图片缺失或无法读取" });
  expect(thumb).toBeDisabled();
  expect(thumb).toHaveTextContent("图片缺失");
  expect(mock.bridge.readHertaChatImage).not.toHaveBeenCalled();
});

it("keeps a long file name whole in its title while the chip shortens it (R78)", () => {
  const name = "一个非常长的文件名，用来检查附件卡片在窄窗口下是否会省略而不是撑开整条消息.pdf";
  render(<ChatMessageAttachments attachments={[{ name, text: "正文", format: "pdf", pages: 12 }]} chatId="c" messageId="m" />);
  const chip = screen.getByRole("button", { name: `查看 ${name}` });
  expect(chip).toHaveAttribute("title", name);
  expect(chip.querySelector(".herta-attachment-name")).toHaveTextContent(name);
  expect(chip).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(chip);
  expect(chip).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("region", { name: `${name} 的内容` })).toHaveTextContent("正文");
});
