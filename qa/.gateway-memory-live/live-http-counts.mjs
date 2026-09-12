import { channel } from "node:diagnostics_channel";
import fs from "node:fs";

const output = process.env.OPENCLAW_PERF_HTTP_COUNTS_PATH;
if (!output) throw new Error("Live transport counts need an owned output path");
const counts = { responses: 0, embeddings: 0, otherOpenAi: 0, responseHeaders: 0, errors: 0 };
const requests = new WeakSet();
channel("undici:request:create").subscribe(({ request }) => {
  if (String(request.origin) !== "https://api.openai.com") return;
  requests.add(request);
  const category =
    request.path === "/v1/responses"
      ? "responses"
      : request.path === "/v1/embeddings"
        ? "embeddings"
        : "otherOpenAi";
  counts[category] += 1;
});
channel("undici:request:headers").subscribe(({ request }) => {
  if (requests.has(request)) counts.responseHeaders += 1;
});
channel("undici:request:error").subscribe(({ request }) => {
  if (requests.has(request)) counts.errors += 1;
});
process.once("exit", (exitCode) => {
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        counts,
        gatewayExitCode: exitCode,
        completeThroughNormalProcessExit: true,
        note: "Undici transport request creation events to api.openai.com in the Gateway main isolate. Includes indexing, retries and background work; not provider billing or proof that a request reached the server. Headers, bodies and credentials are never inspected.",
      },
      null,
      2,
    ),
  );
});
