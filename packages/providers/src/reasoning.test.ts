import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "./contracts.js";
import { reasoningOptions, reasoningChoices } from "./reasoning.js";
const config = (protocol: ProviderConfig["protocol"]) =>
  ({ protocol }) as ProviderConfig;
describe("reasoning wire parameters", () => {
  it("omits defaults and rejects unsupported models", () => {
    expect(reasoningOptions(config("openai-responses"), "custom")).toEqual({});
    expect(reasoningChoices(config("openai-responses"), "custom")).toEqual([]);
    expect(() =>
      reasoningOptions(config("openai-responses"), "custom", "high"),
    ).toThrow();
  });
  it("encodes DeepSeek across three protocols including disabled thinking", () => {
    expect(
      reasoningOptions(
        config("openai-chat-completions"),
        "deepseek-flash",
        "low",
      ),
    ).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(
      reasoningOptions(
        config("openai-chat-completions"),
        "deepseek-flash",
        "none",
      ),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      reasoningOptions(config("anthropic-messages"), "deepseek-v4-pro", "max"),
    ).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    });
    expect(
      reasoningOptions(config("anthropic-messages"), "deepseek-flash", "none"),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      reasoningOptions(config("openai-responses"), "deepseek-flash", "none"),
    ).toEqual({ reasoning: { effort: "none" } });
  });
  it("does not send DeepSeek-specific thinking flags to other model families", () => {
    expect(
      reasoningOptions(config("openai-chat-completions"), "gpt-5", "high"),
    ).toEqual({ reasoning_effort: "high" });
    expect(
      reasoningOptions(
        config("anthropic-messages"),
        "claude-sonnet-4-6",
        "low",
      ),
    ).toEqual({ output_config: { effort: "low" } });
  });
});

it("uses documented controls for preset models and keeps unknown models at service defaults", () => {
  expect(reasoningOptions(config("openai-chat-completions"), "gemini-3.8-flash", "low")).toEqual({ reasoning_effort: "low" });
  expect(reasoningOptions(config("openai-chat-completions"), "kimi-k3", "max")).toEqual({ reasoning_effort: "max" });
  expect(reasoningOptions(config("openai-chat-completions"), "qwen-plus", "none")).toEqual({ enable_thinking: false });
  expect(reasoningOptions(config("openai-chat-completions"), "qwen3.5-plus", "enabled")).toEqual({ enable_thinking: true });
  expect(reasoningOptions(config("anthropic-messages"), "claude-sonnet-5-5", "low")).toEqual({ output_config: { effort: "low" } });
  expect(reasoningChoices(config("openai-responses"), "qwen-plus")).toEqual([]);
  expect(reasoningChoices(config("openai-chat-completions"), "unknown-gemini")).toEqual([]);
});
