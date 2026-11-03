import type { WorkbenchFailure } from "./provider-settings-ipc.js";

/** Fixed vocabulary only. Remote messages/bodies/headers are intentionally ignored. */
export function safeProviderFailure(error: unknown): WorkbenchFailure {
  const raw =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const code = raw.providerCode ?? raw.code;
  const status =
    typeof raw.status === "number" &&
    Number.isInteger(raw.status) &&
    raw.status >= 100 &&
    raw.status <= 599
      ? raw.status
      : undefined;
  const base = { stage: "request" as const, ...(status ? { status } : {}) };
  if (code === "goal-damaged")
    return {
      code: "goal-damaged",
      stage: "configuration",
      message: "目标记录暂时无法读取，本次消息没有发送。请用 /goal 查看并恢复目标记录；草稿仍保留。",
      action: "goal",
    };
  if (
    status === 401 ||
    status === 403 ||
    code === "missing-key" ||
    code === "authentication"
  )
    return {
      ...base,
      code: "authentication",
      message: "服务拒绝鉴权或访问权限。请检查该连接的 API Key 和账户授权。",
      action: "credential",
    };
  if (status === 404 || code === "model-not-found")
    return {
      ...base,
      code: "model-not-found",
      message:
        "服务返回 404：请求端点或模型不存在。请核对所选协议、API 根地址和模型 ID。",
      action: "configure",
    };
  if (status === 429 || code === "rate-limit")
    return {
      ...base,
      code: "rate-limit",
      message: "服务限流，请稍后再试；不会自动重发。",
      action: "retry",
    };
  if (code === "stall" || code === "timeout" || raw.name === "TimeoutError")
    return {
      ...base,
      code: "timeout",
      message: "模型请求超时，已保存的结果保留。请检查连接后再试。",
      action: "retry",
    };
  if (code === "search-limit") return { ...base, stage: "stream", code: "search-limit", message: "本次搜索达到次数或续接上限，已保留收到的内容。可缩小问题范围后继续。", action: "retry" };
  if (code === "sse" || code === "stream-interrupted")
    return {
      ...base,
      stage: "stream",
      code: "stream-interrupted",
      message: "回复流中断或格式异常。已完成的操作保留，不会重复执行工具。",
      action: "retry",
    };
  // R77: the message's own pictures could not go, so nothing was sent (neutral-images.ts). Since
  // F02 design 2.8 only the workbench stops for this, and only when neither of its models is
  // verified for images: an executor model that is gets them with a delegation instead.
  if (code === "image-unsupported")
    return {
      ...base,
      code,
      message:
        "图片没有发给模型：黑塔对话模型和执行模型都未通过识图检测。可在“连接与模型”中对其中一个模型点“测试识图”，或换用已通过的模型后重新发送（若只有执行模型通过，图片随委派发给执行模型，黑塔看不到）；直接再发一次将不附带图片。",
      action: "configure",
    };
  if (code === "image-unreadable")
    return {
      ...base,
      code,
      message:
        "图片没有发给模型：图片副本缺失，或不是能压缩到 2 MB 以内的 PNG、JPEG。请另存为 PNG 或 JPEG 后重新添加。",
      action: "retry",
    };
  if (code === "image-over-limit")
    return {
      ...base,
      code,
      message:
        "图片没有发给模型：一条消息最多附带 8 张图片，总大小也有上限。请分开发送。",
      action: "retry",
    };
  // R110 (F06): the service refused a request that carried pictures (imageRequestRefusal). The
  // status alone does not say why, and the image check's result stands. A failed turn has put its
  // pictures in the record, so the task's next requests show them again (R77).
  if (code === "image-rejected")
    return {
      ...base,
      code,
      message:
        "服务拒绝了这次附带图片的请求。原因未确认：可能与图片有关，也可能是工具参数或其他字段；识图能力没有被自动更改。可在“连接与模型”中对该模型重新测试识图。本任务中已附带的图片在后续请求中仍会一并发送，如需不带图片继续，可新建任务。草稿保留，不会自动重发，也不会重复执行工具。",
      action: "configure",
    };
  if (code === "image-too-large")
    return {
      ...base,
      code,
      message:
        "服务以请求过大（HTTP 413）拒绝了这次附带图片的请求；这不说明模型不支持识图，识图状态未更改。本任务中已附带的图片在后续请求中仍会一并发送，可能再次被拒；可新建任务，改用较小或较少的图片。",
      action: "retry",
    };
  const toolFailures = {
    "tool-json": "本次工具参数不是完整的 JSON，未执行该调用。已完成的操作保留，可调整请求后继续。",
    "tool-schema": "本次工具参数与声明的格式不符，未执行该调用。已完成的操作保留；重复验证模型不一定能解决此问题。",
    "tool-unknown": "模型请求了本轮未提供的工具，该调用未执行。已完成的操作保留。",
    "tool-limit": "本次工具参数超出大小限制，该调用未执行。请将修改拆分后继续。",
    "tool-identity": "本次工具调用缺少有效标识，该调用未执行。已完成的操作保留。",
    "tool-truncated": "工具参数在生成完成前被截断，该调用未执行。可降低思考强度或拆分任务后继续。",
  } as const;
  if (typeof code === "string" && Object.hasOwn(toolFailures, code)) {
    const kind = code as keyof typeof toolFailures;
    return { ...base, stage: "stream", code: kind, message: toolFailures[kind], action: "retry" };
  }
  if (code === "tool-args" || code === "protocol-incompatible")
    return {
      ...base,
      stage: "stream",
      code: "protocol-incompatible",
      message:
        "本次工具调用格式不符合协议，该调用未执行。已完成操作保留；模型通过验证后仍可能偶发此类错误。",
      action: "retry",
    };
  if (raw.name === "AbortError" || code === "cancelled")
    return {
      ...base,
      code: "cancelled",
      message: "请求已取消，已写入的改动不会自动撤销。",
      action: "retry",
    };
  if (code === "network" || code === "network-tls")
    return {
      ...base,
      code: "network",
      message:
        code === "network-tls"
          ? "安全连接失败，请检查证书或代理配置。"
          : "无法连接模型服务，请检查网络与服务地址。",
      action: "configure",
    };
  return {
    ...base,
    code: "service-unavailable",
    message: "模型请求未完成。请检查连接与服务状态；不会自动重发，也不会重复执行工具。",
    action: "retry",
  };
}
