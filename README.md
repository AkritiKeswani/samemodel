# SameModel

**Same model, different provider, different answers.**

On OpenRouter, an open model like DeepSeek V3.2 is served by many providers, each with its own inference stack, quantization and tool-call parser. SameModel runs your test prompts against every provider serving a model, shows which ones break, and suggests a `provider` routing config that avoids them.

- **Live:** https://samemodel.vercel.app (replay three recorded real runs with no key, or paste your own key for a live run)

```bash
git clone https://github.com/AkritiKeswani/samemodel && cd samemodel
npm install && npm run dev                      # UI → http://localhost:3000
cp .env.example .env                            # optional: OPENROUTER_API_KEY for live runs / CLI
npm run bench -- -m deepseek/deepseek-v3.2 -s tool-calling -r 3
```

---

## The pain

**The problem.** The model id stays the same, but the provider behind it changes from call to call, and providers don't behave the same. Developers see it as "my agent randomly returns tool calls as raw text", "empty responses I can't reproduce", or "it's worse than the official API". Nothing in the response's model id says another provider answered, so it looks like a flaky model or a bug in your own code.

**Who has it.** Anyone building agents or structured-output apps on open-weight models through OpenRouter. It's worst for tool calling and JSON, where output either parses or it doesn't.

**How I know it's real.**
- **OpenRouter documented it:** [*Provider Variance: Introducing Exacto*](https://openrouter.ai/blog/announcements/provider-variance-introducing-exacto/) measured tool-call failures that differ by provider, and shipped `:exacto` for about 5 models in response.
- **A production write-up** ([Mo Moustafa](https://mmoustafa.com/blog/so-you-want-to-use-openrouter/), via [Pinggy](https://pinggy.io/blog/openrouter_production_provider_routing_pitfalls/), Sep 2026) reports the same model scoring 81% on TAU-Bench from one provider and 46–58% from others, plus one provider causing about 92% of their empty completions.
- **I reproduced it myself** (see [What it found](#what-it-found)).

## Why this approach

**What I built.** A benchmark harness with a web UI and a CLI that share one engine:
1. **Discover:** `GET /api/v1/models/{model}/endpoints` lists every provider serving the model. Providers that don't support what the tests need (for example, `tools`) are skipped.
2. **Pin and run:** every test goes to each provider with `provider: { order: [tag], allow_fallbacks: false }`, so each result can be traced to one provider. OpenRouter's default routing and `:exacto` run alongside as baselines.
3. **Score:** rule-based checks flag empty replies, tool calls leaked as text, broken or truncated tool arguments, the wrong tool, invalid JSON, and requests a provider rejects.
4. **Suggest:** a provisional `provider` block (`order`, `ignore`, `allow_fallbacks: true`), with a one-line reason for each decision.

Exacto is OpenRouter's curated fix for a few models. SameModel answers the same question for your prompts, on any model, and shows its evidence.

**What I deliberately didn't build.**
- **No AI judge.** A judge model adds its own variance and cost. The failures that break agents can be detected exactly.
- **No monitoring, database or accounts.** One run answers "how should I route this model today?". Scheduled runs with alerts would be next.
- **No automatic routing changes.** It suggests a config for a human to review, because a short benchmark is evidence, not proof.
- **No hosted key.** Visitors watch recorded runs or bring their own key, and runs and spend are capped on the server.

## Technical choices

| Choice | Why |
|---|---|
| **Measure pinned, recommend with fallbacks** | Measuring needs to know exactly which provider answered. Production needs resilience: pinning providers with fallbacks off turns one provider's rate limit into an outage. |
| **Quality and availability scored separately** | Rate limits and timeouts aren't bad output. `ignore` is driven only by quality failures. |
| **Tests most providers fail are excluded** | If nearly every provider fails a test, that's the model or the test, not the provider, so it's left out of provider scores. |
| **Streaming on every call** | It measures time to first token. Tool-call fragments are reassembled before scoring, and errors that arrive mid-stream with HTTP 200 are caught. |
| **Results labelled provisional** | About 10 calls per provider catches broken providers but can't rank healthy ones, and the UI and CLI say so. |
| **Budget guard** | Worst-case cost is estimated before the first call, and the actual `usage.cost` stops a run at the cap. |
| **Concurrency: 8 total, 2 per provider** | Fast enough, without creating the rate limits being measured. |
| **Next.js UI, plain-JS engine** | A streaming route handler (`maxDuration` 300s) powers the live grid. `lib/` has no dependencies, so the CLI shares it. Raw `fetch`, no SDK, so every routing parameter is visible. |
| **Bring-your-own-key** | The key is forwarded to OpenRouter only, never logged, stored or echoed back. |

<a id="what-it-found"></a>
## What it found (Oct 15, 2026, about $0.08 total)

A snapshot from specific tests, 2 runs each. It's not a verdict on any provider.
- **Nebius (fp4), `gpt-oss-120b`:** tool-call arguments came back cut off mid-JSON (`{"city": "Paris", "unit": "`) every time, streaming or not. In the stream, one call was split across `index: 0` and a phantom `index: 1`.
- **Atlas Cloud (fp8), DeepSeek V3.2:** some tool calls came back as plain text (`tool_call_name … tool_call_arguments …`). Default routing sent about 1 in 10 calls there.
- **Together:** rejected an assistant turn with `content: null` and `tool_calls` (400 "prompt cannot be empty"), which every other provider accepts.
- **Novita:** rejected requests it had accepted an hour earlier. Provider behavior drifts.
- **No difference on plain JSON extraction:** all 24 `gpt-oss-120b` providers scored 100%. They differed only in speed (181ms to over 1s to first token) and price (about 5×). The variance is concentrated in tool calling.

## Learnings

- **When every provider fails, suspect your test.** All 24 providers "failed" a test because my checker turned a correct `null` into `""`. That led to labelling each test as a provider-level, mixed or model-level failure.
- **Ambiguous prompts measure the model, not the provider.** "Weather in Paris?" without a unit made DeepSeek ask "Celsius or Fahrenheit?" on some providers. I made the tests unambiguous.
- **Small samples lie.** A provider that answered 2 of 10 calls showed "100% quality" and got recommended. Providers now need to answer at least half their calls to be preferred.
- **A provider's 400 isn't downtime.** Counting Together's rejection as availability hid a real compatibility bug, so it now counts against quality.
- **Leaked tool markup comes in many formats.** Atlas Cloud's format slipped past my first pattern until I read the raw output. `scripts/inspect.js` dumps one provider's raw stream for exactly this.
- **Test against a fake API first.** A model answering with a bare `51` crashed the JSON check. I caught it against a mocked OpenRouter before spending credits.

## Layout

```
lib/            engine: openrouter.js (client) · bench.js (pin, run, aggregate) · checks.js (scoring) · recommend.js
app/            Next.js UI (SameModel.tsx) + streaming run endpoint (api/run)
suites/         tool-calling, json-extraction (add your own JSON suite)
public/replays/ three recorded real runs, replayed without a key
bin/, scripts/  CLI and raw-stream inspector
```
