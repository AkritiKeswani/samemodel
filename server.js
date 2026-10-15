import "./lib/env.js";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./lib/env.js";
import { runBench } from "./lib/bench.js";
import { listSuites, loadSuite, validateSuite } from "./lib/suites.js";
import { recommend } from "./lib/recommend.js";

const PORT = Number(process.env.PORT || 3000);
// Hard server-side caps so a shared deployment can't be used to drain credits.
const MAX_RUNS = 5;
const MAX_SPEND = 2;

async function run(req, res) {
  const opts = JSON.parse((await readBody(req)) || "{}");
  // Bring-your-own-key: a deployed copy uses the visitor's key, never the host's.
  const apiKey = req.headers["x-openrouter-key"] || undefined;

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    const suite = opts.suiteJson ? validateSuite(JSON.parse(opts.suiteJson)) : loadSuite(String(opts.suite || "tool-calling").replace(/[^a-z0-9-]/gi, ""));
    const report = await runBench({
      model: String(opts.model || "openai/gpt-oss-120b").trim(),
      suite,
      runs: Math.min(Math.max(1, Number(opts.runs) || 3), MAX_RUNS),
      maxSpend: Math.min(Number(opts.maxSpend) || 0.5, MAX_SPEND),
      apiKey,
      onEvent: send,
    });
    const needsParams = suite.cases.some((c) => c.tools || c.response_format);
    const recommendation = recommend(report.summary, { priority: opts.priority || "quality", needsParams });
    send({ type: "done", summary: report.summary, cases: report.cases, recommendation, spent: report.spent, aborted: report.aborted, model: report.model });
    const file = `${report.model.replace(/[/:]/g, "_")}-${suite.name}-${Date.now()}.json`;
    writeFile(join(ROOT, "reports", file), JSON.stringify({ ...report, recommendation }, null, 2)).catch(() => {});
  } catch (err) {
    send({ type: "error", message: err.message });
  }
  res.end();
}

const readBody = (req) => new Promise((ok, fail) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => ok(b));
  req.on("error", fail);
});

const json = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "POST" && url.pathname === "/api/run") return await run(req, res);
      if (url.pathname === "/api/suites") return json(res, { suites: listSuites(), serverKey: Boolean(process.env.OPENROUTER_API_KEY) });
      if (url.pathname.startsWith("/api/suites/")) return json(res, loadSuite(url.pathname.split("/").pop().replace(/[^a-z0-9-]/gi, "")));
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(await readFile(join(ROOT, "public", "index.html")));
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  })
  .listen(PORT, () => console.log(`SameModel → http://localhost:${PORT}`));
