import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProviderConfig } from "@herta/providers";
import { ComposerModelPicker } from "./ComposerModelPicker.js";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
it("switches a task model locally, preserves separate executor, saves effort and dismisses", async () => {
  const mock = createMockHertaBridge();
  const p = {
    id: "provider",
    name: "DeepSeek",
    protocol: "openai-chat-completions",
    revision: 1,
    models: ["deepseek-flash", "deepseek-v4-pro"].map((id) => ({
      id,
      validation: { state: "tools-available", providerRevision: 1 },
    })),
  } as unknown as ProviderConfig;
  const view = {
    settings: {
      schemaVersion: 1 as const,
      providers: [p],
      defaultBindings: null,
      sessionBindings: {},
    },
    credentialStatuses: {},
    runtimeActive: true,
  };
  mock.bridge.getProviderSettings = vi.fn(async () => view);
  mock.bridge.setProviderBindings = vi.fn(async () => view);
  const refresh = vi.fn(async () => {}),
    manage = vi.fn();
  const persona = { providerId: p.id, modelId: "deepseek-flash" },
    executor = { providerId: "other", modelId: "separate" };
  render(
    <HertaBridgeProvider bridge={mock.bridge}>
      <ComposerModelPicker
        sessionId="task"
        busy={false}
        readiness={{
          ready: true,
          scope: "session",
          sessionId: "task",
          bindings: { persona, executor },
        }}
        refresh={refresh}
        manage={manage}
      />
    </HertaBridgeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /deepseek-flash/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "deepseek-v4-pro" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(mock.bridge.setProviderBindings).toHaveBeenLastCalledWith({
    sessionId: "task",
    bindings: {
      persona: { providerId: p.id, modelId: "deepseek-v4-pro" },
      executor,
    },
  });
  fireEvent.change(screen.getByLabelText("思考强度"), {
    target: { value: "low" },
  });
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(mock.bridge.setProviderBindings).toHaveBeenLastCalledWith({
    sessionId: "task",
    bindings: { persona: { ...persona, reasoningEffort: "low" }, executor },
  });
  expect(manage).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
