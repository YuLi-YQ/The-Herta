import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Bomb(): JSX.Element {
  throw new Error("kaboom");
}

describe("ErrorBoundary (audit 2026-07-13 T2.2)", () => {
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary label="test" fallback={<div>fallback</div>}>
        <div>content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("contains a render throw to the fallback instead of unmounting the tree", () => {
    // React logs the caught error regardless — keep the test output clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <ErrorBoundary label="row" fallback={<div>row failed</div>}>
          <Bomb />
        </ErrorBoundary>
        <div>sibling survives</div>
      </div>,
    );
    expect(screen.getByText("row failed")).toBeTruthy();
    expect(screen.getByText("sibling survives")).toBeTruthy();
    // The diagnostic names the region.
    expect(
      errSpy.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("render crash in row"),
      ),
    ).toBe(true);
  });

  it("passes the error to a function fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary
        label="fn"
        fallback={(error) => <div>got: {error.message}</div>}
      >
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("got: kaboom")).toBeTruthy();
  });
});
