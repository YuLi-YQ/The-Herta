/** Deterministic loopback protocol fixture. This is NOT an external API pass.
 * No outbound requests, credential persistence, or user-data access. */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export async function startFaultService({ port = 0 } = {}) {
  const records = [];
  let serial = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/__stats") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ deterministicFixture: true, records }));
      return;
    }
    if (req.headers.authorization || req.headers["x-api-key"]) {
      res.writeHead(400);
      res.end("Fixture forbids credentials; configure authentication=none.");
      return;
    }
    if (req.url.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { id: "r4-fixture", display_name: "R4 deterministic fixture" },
          ],
          has_more: false,
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4_000_000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const protocol = req.url.endsWith("/responses")
      ? "openai-responses"
      : req.url.endsWith("/chat/completions")
        ? "openai-chat-completions"
        : req.url.endsWith("/messages")
          ? "anthropic-messages"
          : null;
    if (!protocol) {
      res.writeHead(404);
      res.end();
      return;
    }
    const mode =
      ["hold", "drop", "unavailable", "stall-body", "long", "delay"].find(
        (value) =>
          req.url.includes(`/${value}/`) ||
          raw.includes(`R4:${value.toUpperCase()}`),
      ) ?? "normal";
    const id = ++serial;
    const entry = {
      id,
      protocol,
      mode,
      label: raw.match(/R4:ID=([a-zA-Z0-9_-]+)/)?.[1] ?? "fixture",
      startedAt: new Date().toISOString(),
      completed: false,
      closed: false,
      frames: 0,
    };
    records.push(entry);
    const timers = new Set();
    const pause = (ms) =>
      new Promise((done) => {
        const onClose = () => {
          clearTimeout(timer);
          timers.delete(timer);
          done();
        };
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.removeListener("close", onClose);
          done();
        }, ms);
        timers.add(timer);
        res.once("close", onClose);
      });
    res.on("close", () => {
      entry.closed = true;
      entry.endedAt = new Date().toISOString();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    });
    if (mode === "unavailable") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "fixture_unavailable",
            message: "Deterministic service unavailable",
          },
        }),
      );
      entry.completed = true;
      return;
    }
    if (mode === "hold") {
      await pause(120_000);
      if (res.destroyed) return;
    }
    if (mode === "delay") {
      await pause(Number(raw.match(/R4:DELAY=(\d+)/)?.[1] ?? 1000));
      if (res.destroyed) return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders();
    const frame = (data) => {
      if (res.destroyed) return;
      entry.frames++;
      res.write(
        `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
      );
    };
    const probe = (body.tools ?? []).find(
      (tool) => (tool.name ?? tool.function?.name) === "herta_probe",
    );
    const schema =
      probe?.parameters ?? probe?.function?.parameters ?? probe?.input_schema;
    let call = probe
      ? {
          id: `fixture-call-${id}`,
          name: "herta_probe",
          args: { nonce: schema.properties.nonce.enum[0] },
        }
      : null;
    if (!call && raw.includes("R4:WRITE")) {
      const names = (body.tools ?? []).map(
        (tool) => tool.name ?? tool.function?.name,
      );
      if (names.includes("delegate_execution"))
        call = {
          id: `fixture-delegate-${id}`,
          name: "delegate_execution",
          args: {},
        };
      else if (names.includes("write_new_file"))
        call = {
          id: `fixture-write-${id}`,
          name: "write_new_file",
          args: {
            path: "取消测试.txt",
            content:
              "R4 deterministic approval cancellation must not write this file.\n",
          },
        };
    }
    if (call) entry.tool = call.name;
    const text =
      body.system === "Reply with exactly HERTA_OK." ||
      raw.includes("Reply HERTA_OK.")
        ? "HERTA_OK"
        : `确定性测试 ${entry.label}：本地协议 fixture 文本；未调用外部供应商。`;
    if (protocol === "anthropic-messages") {
      frame({
        type: "message_start",
        message: {
          id: `fixture-${id}`,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      frame({
        type: "content_block_start",
        index: 0,
        content_block: call
          ? { type: "tool_use", id: call.id, name: call.name, input: {} }
          : { type: "text", text: "" },
      });
    }
    if (call) {
      const args = JSON.stringify(call.args);
      if (protocol === "openai-responses") {
        const item = {
          id: `item-${id}`,
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: args,
        };
        frame({
          type: "response.output_item.added",
          item: { ...item, arguments: "" },
        });
        frame({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          delta: args,
        });
        frame({ type: "response.output_item.done", item });
        frame({
          type: "response.completed",
          response: { status: "completed", output: [item] },
        });
      } else if (protocol === "openai-chat-completions") {
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    function: { name: call.name, arguments: args },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        frame({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
        frame("[DONE]");
      } else {
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: args },
        });
        frame({ type: "content_block_stop", index: 0 });
        frame({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 1 },
        });
        frame({ type: "message_stop" });
      }
    } else {
      const pieces =
        mode === "long"
          ? Array.from({ length: 100 }, (_, i) => `${text} [${i + 1}/100]\n`)
          : [text];
      for (const piece of pieces) {
        if (protocol === "openai-responses")
          frame({ type: "response.output_text.delta", delta: piece });
        else if (protocol === "openai-chat-completions")
          frame({
            choices: [
              { index: 0, delta: { content: piece }, finish_reason: null },
            ],
          });
        else
          frame({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: piece },
          });
        if (mode === "drop") {
          await pause(30);
          res.destroy();
          return;
        }
        if (mode === "stall-body") {
          await pause(120_000);
          if (res.destroyed) return;
        }
        if (mode === "long") {
          await pause(100);
          if (res.destroyed) return;
        }
      }
      if (protocol === "openai-responses")
        frame({
          type: "response.completed",
          response: { status: "completed", output: [] },
        });
      else if (protocol === "openai-chat-completions") {
        frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        frame("[DONE]");
      } else {
        frame({ type: "content_block_stop", index: 0 });
        frame({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        });
        frame({ type: "message_stop" });
      }
    }
    entry.completed = true;
    res.end();
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return {
    server,
    records,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await startFaultService({
    port: Number(process.argv[2] ?? 9344),
  });
  console.log(
    JSON.stringify({
      deterministicFixture: true,
      baseURL: service.baseURL,
      credentialPolicy: "rejected",
      outboundNetwork: false,
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void service.close().then(() => process.exit(0)));
}
