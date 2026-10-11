import { cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeviceCard } from "./DeviceCard.js";

afterEach(cleanup);

it("does not consult a legacy enabled 3D preference or acquire a GPU context", () => {
  const getDeviceScene = vi.fn(async () => true);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const mock = createMockHertaBridge({ deviceSceneResult: true });
  const { container } = renderWithLocale(
    <HertaBridgeProvider bridge={{ ...mock.bridge, getDeviceScene }}>
      <DeviceCard />
    </HertaBridgeProvider>,
  );
  expect(getDeviceScene).not.toHaveBeenCalled();
  expect(getContext).not.toHaveBeenCalled();
  expect(container.querySelector("canvas")).toBeNull();
  expect(container.querySelector(".atelier-device-mark")).not.toBeNull();
  getContext.mockRestore();
});
