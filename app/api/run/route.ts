import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBench } from "@/lib/bench.js";
import { validateSuite } from "@/lib/validate.js";
import { recommend } from "@/lib/recommend.js";
import { getSuite } from "@/lib/builtin-suites";

// A full run is a few hundred streamed calls; give it room on serverless hosts.
export const maxDuration = 300;

// Hard server-side caps so a shared deployment can't be used to drain credits.
const MAX_RUNS = 5;
const MAX_SPEND = 2;

export async function POST(req: Request) {
  const opts = await req.json().catch(() => ({}));
  // Bring-your-own-key: a deployed copy uses the visitor's key, never the host's.
  // The key is only forwarded in the Authorization header to OpenRouter. It is
  // never logged, never written to reports/, and never echoed back to the client.
  const apiKey = req.headers.get("x-openrouter-key") || undefined;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        const suite = opts.suiteJson ? validateSuite(JSON.parse(opts.suiteJson)) : getSuite(String(opts.suite || "tool-calling"));
        const report = await runBench({
          model: String(opts.model || "openai/gpt-oss-120b").trim(),
          suite,
          runs: Math.min(Math.max(1, Number(opts.runs) || 3), MAX_RUNS),
          maxSpend: Math.min(Number(opts.maxSpend) || 0.5, MAX_SPEND),
          apiKey,
          onEvent: send,
        });
        const needsParams = suite.cases.some((c: { tools?: unknown; response_format?: unknown }) => c.tools || c.response_format);
        const recommendation = recommend(report.summary, { priority: opts.priority || "quality", needsParams });
        send({ type: "done", summary: report.summary, cases: report.cases, recommendation, spent: report.spent, aborted: report.aborted, model: report.model });
        // Serverless filesystems are read-only; reports are a local-dev nicety.
        if (!process.env.VERCEL) {
          const file = `${report.model.replace(/[/:]/g, "_")}-${suite.name}-${Date.now()}.json`;
          writeFile(join(process.cwd(), "reports", file), JSON.stringify({ ...report, recommendation }, null, 2)).catch(() => {});
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}
