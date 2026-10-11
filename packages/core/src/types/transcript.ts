import type { ToolCallRequest, ToolResult } from "./tool.js";

export interface UserMessage {
  role: "user";
  text: string;
  ts: string;
}

export interface AssistantMessage {
  role: "assistant";
  text: string;
  toolCalls: ToolCallRequest[];
  ts: string;
  reasoningContent?: string;
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  result: ToolResult;
  ts: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;
