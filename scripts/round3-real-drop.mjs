/** Fault injection forwards ONLY to the user-authorized origin. No keys/body logs. */
import http from "node:http";
import https from "node:https";

let armed = false;
const server = http.createServer((req, res) => {
  if (req.url === "/arm" && req.method === "GET") {
    armed = true;
    res.writeHead(200).end("armed");
    return;
  }
  if (req.url !== "/responses" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const dropThisRequest = armed;
  armed = false;
  const upstream = https.request(
    "https://api.deepseek.com/responses",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: req.headers.authorization,
        accept: "text/event-stream",
      },
    },
    (response) => {
      res.writeHead(response.statusCode, {
        "content-type":
          response.headers["content-type"] ?? "application/octet-stream",
      });
      let buffer = "";
      let dropped = false;
      const decoder = new TextDecoder();
      response.on("data", (chunk) => {
        if (dropped) return;
        buffer += decoder.decode(chunk, { stream: true });
        const marker = dropThisRequest
          ? buffer.search(/"type"\s*:\s*"response.output_text.delta"/)
          : -1;
        const end = marker < 0 ? -1 : buffer.indexOf("\n\n", marker);
        if (end >= 0) {
          dropped = true;
          res.write(buffer.slice(0, end + 2));
          console.log(
            JSON.stringify({
              realUpstream: true,
              status: response.statusCode,
              injectedDropAfterTextDelta: true,
            }),
          );
          setTimeout(() => {
            res.destroy();
            response.destroy();
            upstream.destroy();
          }, 150);
        } else if (buffer.length > 1_000_000) {
          res.destroy();
          upstream.destroy();
        }
      });
      response.on("end", () => {
        if (!dropped) {
          res.end(buffer);
          console.log(
            JSON.stringify({
              realUpstream: true,
              status: response.statusCode,
              injectedDropAfterTextDelta: false,
            }),
          );
        }
      });
      response.on("error", () => res.destroy());
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
server.listen(9340, "127.0.0.1", () =>
  console.log("Local fault injector ready; fixed authorized upstream only"),
);
