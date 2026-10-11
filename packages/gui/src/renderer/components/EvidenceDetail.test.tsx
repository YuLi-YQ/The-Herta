// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EvidenceDetail } from "./EvidenceDetail.js";

it("bounds mounted evidence and preserves the full text including a page-boundary emoji", () => {
  const text = `${"a".repeat(7999)}🌟${"b".repeat(10000)}<script>unsafe</script>`;
  const { container } = render(<EvidenceDetail text={text} />);
  expect(container.querySelector("pre")).toBeNull();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  let reconstructed = container.querySelector("pre")!.textContent!;
  expect(reconstructed.length).toBeLessThanOrEqual(8000);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  reconstructed += container.querySelector("pre")!.textContent!;
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  reconstructed += container.querySelector("pre")!.textContent!;
  expect(reconstructed).toBe(text);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByRole("button", { name: "下一页" })).toHaveProperty(
    "disabled",
    true,
  );
});
