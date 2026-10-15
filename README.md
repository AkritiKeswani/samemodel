# SameModel

**Same model, different provider, different answers.**

SameModel runs *your* test cases against every provider serving a model on OpenRouter. It scores each provider on correctness, availability, latency and cost, and writes the `provider` routing block to paste into your requests.

```bash
git clone https://github.com/AkritiKeswani/samemodel && cd samemodel
cp .env.example .env            # add your OpenRouter key
npm start                       # web UI → http://localhost:3000
npm run bench -- -m moonshotai/kimi-k2-0905 -s tool-calling -r 3
```

No dependencies. Node 20+.

> 📹 Demo: _TODO: add Loom / screen recording link_

---

## The pain

**The problem.** When you call `deepseek/deepseek-v3.2` or `moonshotai/kimi-k2-0905` on OpenRouter, you aren't calling one model. You're calling whichever of several providers OpenRouter routes you to. Each provider runs its own inference stack, its own quantization and its own tool-call parser. The model id stays the same, but the behavior doesn't. Developers notice it as:

- "My agent worked yesterday and now tool calls come back as raw `<tool_call>` text."
- "It returns empty responses about 5% of the time and I can't reproduce it."
- "It's noticeably worse than the official API."

The model id gives no hint that a different provider answered, so this looks like a flaky model or a bug in your own code.

**Who has it.** Anyone building agents or structured-output pipelines on open-weight models through OpenRouter. The pain is sharpest for tool calling and JSON extraction, where the output either parses or it doesn't.

**How I know it's real.**

- **OpenRouter has documented it.** [*Provider Variance: Introducing Exacto*](https://openrouter.ai/blog/announcements/provider-variance-introducing-exacto/) (Oct 2025) describes measurable provider-level differences in tool-call validity (invalid JSON, unknown tool names, schema mismatches) across "billions" of calls. They shipped `:exacto` in response, but it covers about 5 models and only tool calling.
- **Production write-ups.** One team's analysis of 18M production messages ([Mo Moustafa, *So you want to use OpenRouter?*](https://mmoustafa.com/blog/so-you-want-to-use-openrouter/), summarized in [Pinggy's *Provider Routing Pitfalls*](https://pinggy.io/blog/openrouter_production_provider_routing_pitfalls/), Sep 2026) reports:
  - one model scoring 81% on TAU-Bench served first-party, versus 46–58% from other providers;
  - one provider accounting for about 92% of their empty completions;
  - providers silently ignoring `reasoning.effort`;
  - a self-inflicted outage from pinning providers with fallbacks disabled.
- **Where I encountered it:** _TODO: link 2–3 specific OpenRouter Discord threads / X posts / Reddit threads, and your own experience._

## Why this approach

**What I built.** A small benchmark harness with two front ends, a CLI and a live web UI:

1. **Discover.** It uses `GET /api/v1/models/{author}/{slug}/endpoints` to find every provider endpoint serving the model, with quantization, price, context length and supported parameters. Endpoints that don't support a parameter the suite needs (for example `tools`) are skipped and reported. They aren't run just to fail.
2. **Pin and run.** Each test case is run N times against each provider, pinned with `provider: { order: [tag], allow_fallbacks: false }`, so every result can be traced to exactly one provider. Two baselines run alongside: **OpenRouter default routing** (what you get with no configuration) and **`:exacto`**.
3. **Score deterministically.** Responses are checked for empty output, tool-call markup leaked into `content`, missing or wrong tool, unparseable tool arguments, wrong argument values, unexpected tool calls, invalid JSON, missing keys and content mismatches.
4. **Recommend.** It ranks providers by quality, cost or latency and emits a `provider` block (`order`, `ignore`, `allow_fallbacks: true`, `require_parameters`) with a one-line reason for each decision.

The positioning against Exacto: Exacto is OpenRouter's curated, general-purpose answer for a handful of models. SameModel answers the same question for *your* prompts, on *any* model, and shows its evidence.

**What I deliberately didn't build.**

- **No LLM-as-judge.** A judge model adds its own variance and cost, and the failures that actually break production (empty replies, leaked tool markup, invalid JSON) are mechanical and can be detected exactly. Open-ended quality scoring is a different problem.
- **No continuous monitoring, database or accounts.** A one-shot bench plus a JSON report in `reports/` answers "how should I route this model *today*". A scheduled run with alerting is the obvious next step.
- **No auto-applied config.** It outputs a routing block for a human to review. Routing is a production decision, and a 2-minute bench is evidence, not proof.
- **No public deployment that spends my credits.** The server supports bring-your-own-key (`x-openrouter-key` header) and caps runs and spend server-side, so a hosted copy can't drain the host's account.

## Technical choices

| Choice | Why |
|---|---|
| **Raw `fetch`, no SDK** | The request body *is* the product. Showing `provider.order`, `allow_fallbacks` and `require_parameters` explicitly makes the routing logic readable. |
| **Streaming for every call** | Time to first token is the latency users feel, and it's only measurable on a stream. Tool-call arguments arrive as fragments keyed by `index` and are reassembled before scoring. |
| **Pin with `allow_fallbacks: false` to measure, recommend `allow_fallbacks: true` to ship** | Measurement needs attribution, and production needs resilience. Pinning a short list with fallbacks off turns one provider's rate limit into your outage, as in the production write-up above. |
| **Quality vs availability, scored separately** | A provider that rate-limits you during a 2-minute bench isn't evidence of bad output. `ignore` is driven only by *quality* failures (broken output given that the provider answered). Rate limits and timeouts lower `availability` but don't get a provider blacklisted. |
| **Test behavior, not labels** | `quantization` on an endpoint is self-reported. fp4 endpoints sometimes match fp8 ones and some top scorers report no quantization at all, so the tool measures outputs instead of trusting metadata. |
| **Baselines in the same grid** | "Default routing" shows what you get today, including *which* providers actually served it (read from the `provider` field on each chunk). That one line usually explains the flakiness people report. |
| **Budget guard before the first call** | Worst-case spend is estimated from endpoint pricing × cases × runs × `max_tokens` and refused if it's over `--max-spend`. Actual spend comes from `usage.cost` on the final stream chunk and stops the run if it crosses the cap. |
| **Concurrency: 8 global, 2 per provider** | Fast enough for a live demo, but low enough per provider that we don't create the rate limits we're trying to measure. |
| **`temperature: 0`, N runs per case** | Reduces sampling noise, so remaining run-to-run variance says something about the endpoint. |
| **Default model `openai/gpt-oss-120b`** | Cheap, widely served by many providers, and has tool support, so there's plenty of provider variety per dollar. |

## What it found (real runs, Oct 15 2026, ~$0.08 total)

Same model id, same request, `temperature: 0`, and results that depend on who serves it:

- **Nebius (fp4) breaks `gpt-oss-120b` tool calls.** The arguments come back cut off mid-JSON, e.g. `{"city": "Paris", "unit": "`. In the stream, Nebius splits a single call across `index: 0` and a phantom `index: 1` with an empty name and id. Without streaming, the tail of the arguments is dropped entirely. It reproduced every time it was tried. Plain-text answers from the same endpoint are fine, so it looks like a tool-call parser bug, not a weights problem. (Diagnosed with `scripts/inspect.js`.)
- **Atlas Cloud (fp8) returns DeepSeek V3.2 tool calls as plain text** (`tool_call_name create_event tool_call_arguments {...}`) instead of structured `tool_calls`. Default routing sent 1 in 10 calls there during one run, so an agent on default routing hits this occasionally, which matches the "randomly breaks" reports.
- **Together rejects a standard OpenAI-format request.** An assistant turn with `content: null` and `tool_calls` gets a 400 "prompt cannot be empty". Every other provider accepts it, and it reproduced across runs.
- **Novita accepted a set of requests, then an hour later rejected the same requests** with an opaque `invalid_request_error`. Provider behavior drifts within hours, so a benchmark is a snapshot.
- **One Friendli response misread `2026-11-03` in the prompt as `"2026-11 03"`** and asked the user to fix a typo that wasn't there.
- **Where providers *don't* differ.** On plain JSON extraction, all 24 `gpt-oss-120b` endpoints scored 100% quality. They differed only on speed and price: TTFT from 181ms to over 1s, throughput from about 20 to over 1,700 tok/s, and roughly 5× on $/call. The variance concentrates in **tool calling**, which is where agents live.
- **Default routing** for DeepSeek V3.2 tool calls spread across 4 providers (Friendli, Venice, Atlas Cloud, DeepInfra) and scored 75% quality. Pinning the top-ranked providers scored 100% at similar or lower cost.

Caveat: with 2 runs per case (10 calls per provider per suite), the clear outliers (Nebius, Atlas Cloud, Together) reproduce across runs, but the ordering among the good providers shuffles from run to run. Use `-r 5` before trusting fine-grained rankings.

## Learnings

- **When every provider fails a case, suspect your test first.** My `missing-field` case failed on all 24 endpoints. The models were right (`"email": null`); my checker did `obj[k] ?? ""`, which turned a correct `null` into `""`. That became a feature: SameModel now classifies each case as **provider-level** (a minority of providers fail it), **mixed**, or **model-level** (most fail it). Model-level cases are excluded from provider scores, because a case nobody passes can't tell providers apart. For DeepSeek V3.2, `nested-args` is model-level: the model over-asks for clarification on almost every provider.
- **Ambiguous tests measure the model's personality, not the provider.** My first weather case didn't specify a unit, and DeepSeek asked "Celsius or Fahrenheit?" on some providers. That's arguably reasonable, but it shows up as a "failure". I made the prompt unambiguous so failures mean something.
- **Small samples lie.** Google Vertex answered 2 of 10 calls (8 rate-limited), both correct, so it showed "100% quality" and was recommended second. Providers now need to answer at least half their calls to be *preferred*. The others stay eligible as fallbacks.
- **"Provider returned error" 400s aren't downtime.** I first counted Together's 400 as availability, which hid a real compatibility bug. Upstream 400s for requests other providers accept now count against quality (`rejects_valid_request`).
- **Leaked tool markup has many dialects.** I started with `<tool_call>`-style tags. Atlas Cloud's `tool_call_name … tool_call_arguments …` slipped through as a vaguer `missing_tool_call` until I read the raw output and added that pattern.
- **"Valid JSON" isn't always an object.** A model replying with a bare `51` crashed the checker (`key in 51`). I caught it against a mocked OpenRouter API (scripted good, leaky, empty and rate-limited providers) before spending real credits.
- **Much of the "unreliability" is upstream rate limiting.** Venice, DeepInfra Turbo and others often returned `429 … temporarily rate-limited upstream`. That's why availability and quality are separate columns, and why the recommended config never disables fallbacks.
- **Smaller API details:** `usage: { include: true }` is deprecated (cost now arrives automatically on the last stream chunk). `:exacto` doesn't exist for most models (baselines short-circuit after the first 404). Mid-stream failures arrive as HTTP 200 with an `error` chunk, and they're classified as `provider_error` rather than "empty".

## Writing your own suite

A suite is a JSON file in `suites/` (or paste one into the UI):

```jsonc
{
  "name": "my-agent",
  "cases": [
    {
      "id": "refund-tool",
      "messages": [{ "role": "user", "content": "Refund order #4417, it arrived broken." }],
      "tools": [/* OpenAI-format tool definitions */],
      "max_tokens": 1024,
      "expect": {
        "tool_call": { "name": "issue_refund", "required_args": ["order_id"], "args_match": { "order_id": "4417" } }
        // or: "no_tool_call": true · "json": { "required_keys": [...], "match": {...} }
        //     "contains": [...] · "not_contains": [...] · "regex": "..."
      }
    }
  ]
}
```

## Layout

```
lib/openrouter.js   endpoints lookup + streaming client (handles mid-stream errors)
lib/bench.js        targets, pinning, concurrency, budget guard, aggregation
lib/checks.js       deterministic scoring + failure taxonomy
lib/recommend.js    summary → provider routing config
scripts/inspect.js  dump one provider's raw stream for one case (how the Nebius bug was found)
bin/samemodel.js    CLI
server.js           SSE server for the UI (BYOK, server-side caps)
public/index.html   live grid, leaderboard, config
suites/             tool-calling, json-extraction
```
