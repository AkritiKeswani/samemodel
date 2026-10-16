#!/usr/bin/env node
import "../lib/env.js";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/env.js";
import { runBench } from "../lib/bench.js";
import { loadSuite } from "../lib/suites.js";
import { recommend, pct, ms, usd } from "../lib/recommend.js";

const { values: a } = parseArgs({
  options: {
    model: { type: "string", short: "m", default: "openai/gpt-oss-120b" },
    suite: { type: "string", short: "s", default: "tool-calling" },
    runs: { type: "string", short: "r", default: "3" },
    "max-spend": { type: "string", default: "0.50" },
    priority: { type: "string", short: "p", default: "quality" },
    concurrency: { type: "string", default: "8" },
    timeout: { type: "string", default: "60" },
    "no-baselines": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (a.help) {
  console.log(`samemodel — same model, different provider, different answers.

  -m, --model        OpenRouter model id            (default openai/gpt-oss-120b)
  -s, --suite        suite name or path to JSON     (default tool-calling)
  -r, --runs         repeats per case per provider  (default 3)
      --max-spend    abort above this many USD      (default 0.50)
  -p, --priority     quality | cost | latency       (default quality)
      --timeout      seconds per call before it counts as a timeout (default 60)
      --no-baselines skip default-routing and :exacto rows`);
  process.exit(0);
}

const suite = loadSuite(a.suite);
const runs = Number(a.runs);
let done = 0;
let total = 0;

const report = await runBench({
  model: a.model,
  suite,
  runs,
  maxSpend: Number(a["max-spend"]),
  concurrency: Number(a.concurrency),
  timeoutMs: Number(a.timeout) * 1000,
  baselines: !a["no-baselines"],
  onEvent(e) {
    if (e.type === "plan") {
      total = e.targets.length * e.cases.length * runs;
      console.log(`\n${e.model} · suite "${e.suite}" · ${e.targets.length} targets × ${e.cases.length} cases × ${runs} runs = ${total} calls · worst-case est. ${usd(e.estimate)}`);
      for (const s of e.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
    }
    if (e.type === "result") {
      done++;
      process.stdout.write(`\r  ${done}/${total} ${e.pass ? "✓" : "✗"} ${e.targetId.padEnd(28)} ${e.caseId.padEnd(24)}`);
    }
  },
}).catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
process.stdout.write("\n\n");

const cols = [
  ["target", 30, (s) => s.id],
  ["quant", 8, (s) => s.quantization ?? ""],
  ["pass", 6, (s) => pct(s.passRate)],
  ["quality", 8, (s) => pct(s.qualityRate)],
  ["avail", 6, (s) => pct(s.availability)],
  ["TTFT p50", 9, (s) => ms(s.p50TtftMs)],
  ["tok/s", 6, (s) => s.p50TokensPerSec ?? "—"],
  ["$/call", 9, (s) => usd(s.avgCost)],
  ["failures", 0, (s) => Object.entries(s.failures).map(([k, v]) => `${k}×${v}`).join(" ")],
];
console.log(cols.map(([h, w]) => h.padEnd(w)).join(" "));
const sorted = [...report.summary].sort((x, y) => (y.qualityRate ?? -1) - (x.qualityRate ?? -1));
for (const s of sorted) console.log(cols.map(([, w, f]) => String(f(s)).padEnd(w)).join(" "));

console.log("\nPer case (providers that answered):");
for (const c of report.cases) {
  const note = c.verdict === "model-level" ? "← most providers fail: the model/prompt, not provider variance"
    : c.verdict === "provider-level" ? `← provider-specific: ${c.failingProviders.join(", ")}`
    : c.verdict === "mixed" ? `← mixed: the model is borderline here, some providers make it worse (${c.failingProviders.length} failing)` : "";
  console.log(`  ${c.id.padEnd(26)} ${pct(c.passRate).padStart(4)}  ${note}`);
}

const def = report.summary.find((s) => s.id === "default");
if (def && Object.keys(def.servedBy).length) console.log(`\ndefault routing was served by: ${Object.entries(def.servedBy).map(([k, v]) => `${k}×${v}`).join(", ")}`);

const needsParams = suite.cases.some((c) => c.tools || c.response_format);
const rec = recommend(report.summary, { priority: a.priority, needsParams });
console.log(`\nRecommended routing (${rec.priority}):\n`);
console.log(JSON.stringify({ model: a.model, provider: rec.provider }, null, 2));
console.log("");
for (const r of rec.reasons) console.log(`  · ${r}`);
console.log(`\n  ${rec.caveat}`);
if (report.aborted) console.log(`\n${report.aborted}`);
console.log(`\nspent ${usd(report.spent)}`);

const file = join(ROOT, "reports", `${a.model.replace(/[/:]/g, "_")}-${suite.name}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ ...report, recommendation: rec }, null, 2));
console.log(`report → ${file.replace(ROOT + "/", "")}`);
