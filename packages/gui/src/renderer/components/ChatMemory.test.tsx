import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryProposal } from "./ChatMemory.js";

it("reports a failed memory proposal next to the proposal and allows a retry (R62)", async () => {
  const onManage = vi
    .fn()
    .mockResolvedValueOnce("记忆文件无法读取，原文件已保留。")
    .mockResolvedValueOnce(null);
  render(
    <MemoryProposal
      text={'{"operation":"save","text":"喜欢猫"}'}
      onManage={onManage}
    />,
  );
  const card = screen
    .getByText("待确认的记忆更改")
    .closest("section") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "确认记住" }));
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "记忆文件无法读取，原文件已保留。",
  );
  fireEvent.click(within(card).getByRole("button", { name: "确认记住" }));
  expect(
    await within(card).findByRole("button", { name: "已保存" }),
  ).toBeDisabled();
  expect(within(card).queryByRole("alert")).toBeNull();
  expect(onManage).toHaveBeenCalledTimes(2);
});
