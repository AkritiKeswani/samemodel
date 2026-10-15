#!/usr/bin/env node
// Print the raw tool-call deltas one provider streams back for one case.
// This is how the Nebius split-tool-call bug was diagnosed.
//   node scripts/inspect.js nebius/fp4 [model] [suite] [caseId] [--nostream]
import "../lib/env.js";
import { loadSuite } from "../lib/suites.js";

const [tag, model = "openai/gpt-oss-120b", suiteName = "tool-calling", caseId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const stream = !process.argv.includes("--nostream");
if (!tag) { console.log("usage: node scripts/inspect.js <provider-tag> [model] [suite] [caseId] [--nostream]"); process.exit(1); }
const suite = loadSuite(suiteName);
const kase = suite.cases.find((c) => c.id === caseId) ?? suite.cases[0];
const body = { model, stream, temperature: 0, max_tokens: kase.max_tokens ?? 1024, messages: kase.messages, tools: kase.tools, provider: { order: [tag], allow_fallbacks: false } };

const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const txt = await res.text();
if (!res.ok) { console.log(res.status, txt); process.exit(1); }
if (!stream) { const j = JSON.parse(txt); console.log(j.provider, JSON.stringify(j.choices[0].message, null, 2)); process.exit(0); }
for (const line of txt.split("\n")) {
  if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
  const c = JSON.parse(line.slice(5));
  const ch = c.choices?.[0];
  if (ch?.delta?.tool_calls || ch?.delta?.content || ch?.finish_reason) console.log(JSON.stringify({ provider: c.provider, tool_calls: ch.delta?.tool_calls, content: ch.delta?.content, finish: ch.finish_reason }));
}
