import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../ipc/mock-bridge.js";
import { useApprovalPending } from "./useApprovalPending.js";

function Probe(): JSX.Element {
  return (
    <span data-testid="pending">{useApprovalPending() ? "yes" : "no"}</span>
  );
}

function setup(): MockHertaBridge {
  const mock = createMockHertaBridge();
  render(
    <HertaBridgeProvider bridge={mock.bridge}>
      <Probe />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("useApprovalPending", () => {
  it("is false when there is no overlay", () => {
    setup();
    expect(screen.getByTestId("pending").textContent).toBe("no");
  });

  it("is true while a permission is pending, false after resolved", () => {
    const mock = setup();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r1",
          risk: "workspace_write",
          tool: "write_new_file",
          summary: "x",
        },
      });
    });
    expect(screen.getByTestId("pending").textContent).toBe("yes");
    act(() => {
      mock.emitOverlay({ kind: "resolved", requestId: "r1" });
    });
    expect(screen.getByTestId("pending").textContent).toBe("no");
  });
});
