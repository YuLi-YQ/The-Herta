import { imageSupport, validateMessageImage, imageDataURL } from "../images.js";
import type { ToolResult } from "@herta/core";
import type {
  ModelRequest,
  NeutralMessage,
  ProviderConfig,
} from "../contracts.js";
import { webSearchSupport } from "../web-search.js";
import { reasoningOptions } from "../reasoning.js";
import { failure } from "./common.js";
import { nativeOverrides } from "./native.js";

function resultText(result: ToolResult): string {
  return (
    result.modelText ??
    JSON.stringify({
      ok: result.ok,
      summary: result.summary,
      data: result.data,
      error: result.error,
      suggestion: result.suggestion,
    })
  );
}
function checkHistory(messages: readonly NeutralMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls) {
        if (pending.has(call.id))
          throw failure("Duplicate tool call in transcript");
        pending.add(call.id);
      }
    if (message.role === "tool" && !pending.delete(message.toolCallId))
      throw failure("Tool result has no matching call in transcript");
  }
  if (pending.size) throw failure("Transcript contains unresolved tool calls");
}
export function encode(request: ModelRequest, config: ProviderConfig): unknown {
  checkHistory(request.messages);
  let imageCount = 0, imageBytes = 0;
  for (const m of request.messages) if (m.role === "user" && m.images?.length) {
    if (!imageSupport(config, request.modelId)) throw failure("Image input is not supported for this endpoint/model");
    for (const i of m.images) { validateMessageImage(i); imageCount++; imageBytes += i.data.length; }
  }
  if (imageCount > 8 || imageBytes > 12 * 1024 * 1024) throw failure("Image context exceeds local limit");
  if (request.options.webSearch && !webSearchSupport(config, request.modelId))
    throw failure("Web search is not supported for this endpoint/model");
  if (
    request.options.maxWebSearchUses !== undefined &&
    (!Number.isInteger(request.options.maxWebSearchUses) ||
      request.options.maxWebSearchUses < 0 ||
      request.options.maxWebSearchUses > 3)
  )
    throw failure("Invalid search budget");
  const searchEnabled =
    request.options.webSearch && request.options.maxWebSearchUses !== 0;
  const native = nativeOverrides(request);
  const max =
    request.options.maxOutputTokens ?? config.defaults.maxOutputTokens;
  const temperature =
    request.options.temperature ?? config.defaults.temperature;
  const common = {
    model: request.modelId,
    stream: true,
    ...reasoningOptions(
      config,
      request.modelId,
      request.options.reasoningEffort,
    ),
    ...(temperature === undefined ? {} : { temperature }),
  };
  // Official compatibility endpoints document max_tokens. Keep the OpenAI
  // max_completion_tokens convention for unknown/custom gateways.
  const host = new URL(config.baseURL).hostname;
  const legacyChatLimit =
    [
      "api.deepseek.com",
      "api.moonshot.cn",
      "open.bigmodel.cn",
      "generativelanguage.googleapis.com",
    ].includes(host) || host.endsWith(".aliyuncs.com");
  if (config.protocol === "openai-chat-completions")
    return {
      ...common,
      stream_options: { include_usage: true },
      ...(max === undefined
        ? {}
        : legacyChatLimit
          ? { max_tokens: max }
          : { max_completion_tokens: max }),
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map(
          (message, index) =>
            native.get(index) ??
            (message.role === "user"
              ? { role: "user", content: message.images?.length ? [{ type: "text", text: message.text }, ...message.images.map(i => ({ type: "image_url", image_url: { url: imageDataURL(i) } }))] : message.text }
              : message.role === "tool"
                ? {
                    role: "tool",
                    tool_call_id: message.toolCallId,
                    content: resultText(message.result),
                  }
                : {
                    role: "assistant",
                    content: message.text || null,
                    ...(message.toolCalls.length
                      ? {
                          tool_calls: message.toolCalls.map((call) => ({
                            id: call.id,
                            type: "function",
                            function: {
                              name: call.tool,
                              arguments: JSON.stringify(call.input),
                            },
                          })),
                        }
                      : {}),
                  }),
        ),
      ],
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: false,
              },
            })),
          }
        : {}),
    };
  if (config.protocol === "openai-responses")
    return {
      ...common,
      instructions: request.system,
      store: false,
      include: [
        "reasoning.encrypted_content",
        ...(searchEnabled ? ["web_search_call.action.sources"] : []),
      ],
      ...(searchEnabled
        ? { max_tool_calls: request.options.maxWebSearchUses ?? 3 }
        : {}),
      ...(max === undefined ? {} : { max_output_tokens: max }),
      input: request.messages.flatMap<unknown>(
        (message, index) =>
          native.get(index) ??
          (message.role === "user"
            ? [{ role: "user", content: message.images?.length ? [{ type: "input_text", text: message.text }, ...message.images.map(i => ({ type: "input_image", image_url: imageDataURL(i), detail: "auto" }))] : message.text }]
            : message.role === "tool"
              ? [
                  {
                    type: "function_call_output",
                    call_id: message.toolCallId,
                    output: resultText(message.result),
                  },
                ]
              : [
                  ...(message.text
                    ? [{ role: "assistant", content: message.text }]
                    : []),
                  ...message.toolCalls.map((call) => ({
                    type: "function_call",
                    call_id: call.id,
                    name: call.tool,
                    arguments: JSON.stringify(call.input),
                  })),
                ]),
      ),
      ...(request.tools.length || searchEnabled
        ? {
            tools: [
              ...(searchEnabled ? [{ type: "web_search" }] : []),
              ...request.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: false,
              })),
            ],
          }
        : {}),
    };
  const messages: { role: string; content: unknown[] }[] = [];
  for (const [index, message] of request.messages.entries()) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content =
      (native.get(index) as unknown[] | undefined) ??
      (message.role === "user"
        ? [{ type: "text", text: message.text }, ...(message.images ?? []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))]
        : message.role === "tool"
          ? [
              {
                type: "tool_result",
                tool_use_id: message.toolCallId,
                content: resultText(message.result),
                is_error: !message.result.ok,
              },
            ]
          : [
              ...(message.text ? [{ type: "text", text: message.text }] : []),
              ...message.toolCalls.map((call) => ({
                type: "tool_use",
                id: call.id,
                name: call.tool,
                input: call.input,
              })),
            ]);
    if (!content.length) continue;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    ...common,
    system: request.system,
    max_tokens: max ?? 4096,
    messages,
    ...(request.tools.length || searchEnabled
      ? {
          tools: [
            ...(searchEnabled
              ? [
                  {
                    type: "web_search_20250305",
                    name: "web_search",
                    max_uses: request.options.maxWebSearchUses ?? 3,
                  },
                ]
              : []),
            ...request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          ],
        }
      : {}),
  };
}
