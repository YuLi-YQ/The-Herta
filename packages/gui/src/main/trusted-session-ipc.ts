import type { IpcMainInvokeEvent, WebContents } from "electron";

/** Bind privileged handlers to this window's actual main frame and owned URL. */
export function createTrustedSessionIpcGuard(
  contents: WebContents,
  options: { appFileUrl: string; installed: boolean; devRendererUrl?: string },
) {
  const devUrl = !options.installed ? options.devRendererUrl : undefined;
  return (event: IpcMainInvokeEvent): boolean => {
    if (
      contents.isDestroyed() ||
      event?.sender !== contents ||
      !event.senderFrame ||
      event.senderFrame !== contents.mainFrame
    )
      return false;
    const url = event.senderFrame.url;
    if (url.split(/[?#]/, 1)[0] === options.appFileUrl) return true;
    if (!devUrl) return false;
    try {
      const target = new URL(url),
        dev = new URL(devUrl);
      return (
        ["http:", "https:"].includes(dev.protocol) &&
        target.origin === dev.origin
      );
    } catch {
      return false;
    }
  };
}
