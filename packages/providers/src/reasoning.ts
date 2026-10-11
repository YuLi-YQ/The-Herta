import type { ProviderConfig } from "./contracts.js";
/** Conservative support list. Unknown models retain provider defaults. */
export function reasoningChoices(
  config: ProviderConfig,
  model: string,
): readonly string[] {
  if (config.protocol === "openai-chat-completions") {
    if (/^gemini-3\.8-flash$/.test(model)) return ["low", "medium", "high"];
    if (model === "kimi-k3") return ["low", "high", "max"];
    if (["qwen-plus", "qwen3.5-plus"].includes(model)) return ["none", "enabled"];
  }
  if (/^deepseek-(flash|v4-pro)$/.test(model))
    return ["none", "low", "high", "max"];
  if (
    config.protocol !== "anthropic-messages" &&
    /^(gpt-5(?:\.[124])?(?:-mini|-nano|-codex)?|gpt-6(?:\.1)?-(?:sol|astra|luna)|o3(?:-mini)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model,
    )
  )
    return ["low", "medium", "high"];
  if (
    config.protocol === "anthropic-messages" &&
    /^claude-(opus-4-[56]|sonnet-4-6|(?:opus|sonnet|haiku)-5-5)(?:$|-)/.test(model)
  )
    return ["low", "medium", "high"];
  return [];
}
export function reasoningOptions(
  config: ProviderConfig,
  model: string,
  effort?: string,
): Record<string, unknown> {
  if (!effort) return {};
  if (!reasoningChoices(config, model).includes(effort))
    throw new Error("Unsupported reasoning effort for this model");
  if (config.protocol === "openai-chat-completions" && ["qwen-plus", "qwen3.5-plus"].includes(model))
    return { enable_thinking: effort !== "none" };
  const deepseek = /^deepseek-(flash|v4-pro)$/.test(model);
  if (config.protocol === "openai-responses") return { reasoning: { effort } };
  if (config.protocol === "anthropic-messages")
    return {
      ...(deepseek
        ? { thinking: { type: effort === "none" ? "disabled" : "enabled" } }
        : {}),
      ...(effort === "none" ? {} : { output_config: { effort } }),
    };
  return {
    ...(deepseek
      ? { thinking: { type: effort === "none" ? "disabled" : "enabled" } }
      : {}),
    ...(effort === "none" ? {} : { reasoning_effort: effort }),
  };
}
