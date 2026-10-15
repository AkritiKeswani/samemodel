import { listEndpoints, chatStream } from "./openrouter.js";
import { evaluate, classifyError, AVAILABILITY_FAILURES } from "./checks.js";

/**
 * Run a test suite against every provider endpoint serving `model`,
 * plus two baselines: OpenRouter's default routing and `:exacto`.
 *
 * Each provider is pinned with { order: [tag], allow_fallbacks: false } so a
 * result is attributable to exactly one provider. (In production you would
 * never disable fallbacks — see recommend.js.)
 */
export async function runBench({
  model,
  suite,
  runs = 3,
  maxSpend = 0.5,
  concurrency = 8,
  perTargetConcurrency = 2,
  timeoutMs = 60_000,
  baselines = true,
  apiKey,
  onEvent = () => {},
}) {
  const endpoints = await listEndpoints(model, apiKey);
  const needs = requiredParams(suite);

  const targets = [];
  const skipped = [];
  for (const ep of endpoints) {
    const missing = needs.filter((p) => !(ep.supported_parameters || []).includes(p));
    const meta = endpointMeta(ep);
    if (missing.length) {
      skipped.push({ ...meta, reason: `doesn't support ${missing.join(", ")}` });
      continue;
    }
    targets.push({
      ...meta,
      kind: "provider",
      model,
      provider: { order: [ep.tag], allow_fallbacks: false },
    });
  }
  if (baselines) {
    const maxPrice = targets.reduce((m, t) => ({ prompt: Math.max(m.prompt, t.price.prompt), completion: Math.max(m.completion, t.price.completion) }), { prompt: 0, completion: 0 });
    targets.push({ id: "default", label: "OpenRouter default routing", kind: "baseline", model, provider: needs.length ? { require_parameters: true } : undefined, price: maxPrice });
    targets.push({ id: "exacto", label: ":exacto", kind: "baseline", model: `${model.split(":")[0]}:exacto`, provider: needs.length ? { require_parameters: true } : undefined, price: maxPrice });
  }

  // Budget guard: estimate worst case before spending anything.
  const estimate = targets.reduce((sum, t) => sum + suite.cases.reduce((s, c) => s + estimateCost(c, t.price), 0) * runs, 0);
  onEvent({ type: "plan", model, suite: suite.name, runs, cases: suite.cases.map((c) => ({ id: c.id, description: c.description })), targets: targets.map(publicTarget), skipped, estimate });
  if (estimate > maxSpend) {
    throw new Error(`Estimated worst-case spend $${estimate.toFixed(4)} exceeds --max-spend $${maxSpend}. Lower --runs, trim the suite, or raise the cap.`);
  }

  const results = [];
  let spent = 0;
  let aborted = null;
  const global = semaphore(concurrency);

  await Promise.all(
    targets.map(async (target) => {
      const local = semaphore(perTargetConcurrency);
      const jobs = [];
      for (const kase of suite.cases) for (let run = 1; run <= runs; run++) jobs.push({ kase, run });

      // A baseline that doesn't exist for this model (e.g. no :exacto variant)
      // fails on its first request; don't burn the remaining jobs on it.
      let unavailable = false;

      await Promise.all(
        jobs.map(({ kase, run }) =>
          local(() =>
            global(async () => {
              if (aborted || unavailable) return;
              const r = await runOne(target, kase, timeoutMs, apiKey);
              if (target.kind === "baseline" && (r.failure === "no_endpoint" || r.failure === "bad_request")) unavailable = true;
              spent += r.cost || 0;
              if (spent > maxSpend && !aborted) aborted = `Stopped: actual spend $${spent.toFixed(4)} passed the $${maxSpend} cap.`;
              const row = { targetId: target.id, caseId: kase.id, run, ...r };
              results.push(row);
              onEvent({ type: "result", ...row });
            }),
          ),
        ),
      );
      if (unavailable) onEvent({ type: "unavailable", targetId: target.id });
    }),
  );

  const cases = caseStats(suite, targets, results);
  // A case every provider fails can't tell providers apart; leave it out of
  // provider quality so it doesn't punish whoever happened to answer it.
  const modelLevel = new Set(cases.filter((c) => c.verdict === "model-level").map((c) => c.id));
  const summary = summarize(targets, results, modelLevel);
  return { model, suite: suite.name, runs, targets: targets.map(publicTarget), skipped, results, summary, cases, spent, aborted, ranAt: new Date().toISOString() };
}

async function runOne(target, kase, timeoutMs, apiKey) {
  const body = {
    model: target.model,
    messages: kase.messages,
    max_tokens: kase.max_tokens ?? 1024,
    temperature: kase.temperature ?? 0,
  };
  if (kase.tools) body.tools = kase.tools;
  if (kase.tool_choice) body.tool_choice = kase.tool_choice;
  if (kase.response_format) body.response_format = kase.response_format;
  if (kase.reasoning) body.reasoning = kase.reasoning;
  if (target.provider) body.provider = target.provider;

  const t0 = performance.now();
  let ttft = null;
  let content = "";
  const toolCalls = [];
  let finishReason = null;
  let servedBy = null;
  let usage = null;

  try {
    const stream = await chatStream(body, { signal: AbortSignal.timeout(timeoutMs), apiKey });
    for await (const chunk of stream) {
      servedBy ??= chunk.provider ?? null;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (ttft === null && (d.content || d.reasoning || d.tool_calls)) ttft = performance.now() - t0;
      if (d.content) content += d.content;
      // Tool calls stream as fragments keyed by index: the name arrives once,
      // the JSON arguments arrive in pieces that must be concatenated.
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? toolCalls.length;
        toolCalls[i] ??= { name: "", arguments: "" };
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (err) {
    return {
      pass: false,
      failure: classifyError(err),
      detail: err.message.slice(0, 200),
      availability: true,
      servedBy,
      totalMs: Math.round(performance.now() - t0),
    };
  }

  const totalMs = performance.now() - t0;
  const verdict = evaluate({ content, toolCalls: toolCalls.filter(Boolean), finishReason }, kase.expect);
  const outTokens = usage?.completion_tokens ?? null;
  const genSeconds = ttft !== null ? (totalMs - ttft) / 1000 : null;
  return {
    ...verdict,
    availability: false,
    servedBy,
    ttftMs: ttft !== null ? Math.round(ttft) : null,
    totalMs: Math.round(totalMs),
    tokensPerSec: outTokens && genSeconds > 0.05 ? Math.round(outTokens / genSeconds) : null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: outTokens,
    cost: usage?.cost ?? null,
    output: content.slice(0, 400),
    toolCalls: toolCalls.filter(Boolean),
  };
}

export function summarize(targets, results, modelLevel = new Set()) {
  return targets.map((t) => {
    const rows = results.filter((r) => r.targetId === t.id);
    const n = rows.length;
    const passes = rows.filter((r) => r.pass).length;
    const availFails = rows.filter((r) => AVAILABILITY_FAILURES.has(r.failure)).length;
    const scored = rows.filter((r) => !AVAILABILITY_FAILURES.has(r.failure) && !modelLevel.has(r.caseId));
    const answered = n - availFails;
    const failures = {};
    for (const r of rows) if (r.failure) failures[r.failure] = (failures[r.failure] || 0) + 1;
    const servedBy = {};
    for (const r of rows) if (r.servedBy) servedBy[r.servedBy] = (servedBy[r.servedBy] || 0) + 1;
    const costs = rows.map((r) => r.cost).filter((c) => c != null);
    return {
      ...publicTarget(t),
      // A baseline whose model variant doesn't exist (e.g. no :exacto for this model).
      unavailable: t.kind === "baseline" && n > 0 && rows.every((r) => r.failure === "no_endpoint" || r.failure === "bad_request"),
      n,
      passes,
      passRate: n ? passes / n : null,
      // Quality given that the provider actually answered. Separates
      // "returns broken output" from "was down / rate limited right now".
      // excludes model-level cases (see caseStats).
      qualityRate: scored.length ? scored.filter((r) => r.pass).length / scored.length : null,
      availability: n ? answered / n : null,
      failures,
      servedBy,
      p50TtftMs: median(rows.map((r) => r.ttftMs)),
      p50TokensPerSec: median(rows.map((r) => r.tokensPerSec)),
      avgCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      totalCost: costs.reduce((a, b) => a + b, 0),
    };
  });
}

/**
 * Per-case pass rate across *providers*. If most providers fail a case, the
 * cause is the model (or the prompt), not the provider — so it shouldn't be
 * read as provider variance. If only a few fail, it is.
 */
export function caseStats(suite, targets, results) {
  const providers = new Set(targets.filter((t) => t.kind === "provider").map((t) => t.id));
  return suite.cases.map((c) => {
    const rows = results.filter((r) => r.caseId === c.id && providers.has(r.targetId) && !AVAILABILITY_FAILURES.has(r.failure));
    const passRate = rows.length ? rows.filter((r) => r.pass).length / rows.length : null;
    const failing = [...new Set(rows.filter((r) => !r.pass).map((r) => r.targetId))];
    // Judge per provider, not per call, so two broken providers can't make
    // a case look like a model problem: a provider "handles" a case if it
    // passes at least half its runs.
    const ids = [...new Set(rows.map((r) => r.targetId))];
    const answering = ids.length;
    const handled = ids.filter((id) => {
      const rs = rows.filter((r) => r.targetId === id);
      return rs.filter((r) => r.pass).length / rs.length >= 0.5;
    }).length;
    let verdict = "clean";
    if (passRate == null) verdict = "no data";
    else if (handled / answering < 1 / 3) verdict = "model-level";
    else if (failing.length && failing.length <= answering / 3) verdict = "provider-level";
    else if (failing.length) verdict = "mixed";
    return { id: c.id, description: c.description, passRate, failingProviders: failing, verdict };
  });
}

function endpointMeta(ep) {
  return {
    id: ep.tag,
    label: ep.provider_name,
    quantization: ep.quantization ?? "unknown",
    contextLength: ep.context_length,
    price: { prompt: Number(ep.pricing?.prompt ?? 0), completion: Number(ep.pricing?.completion ?? 0) },
    uptime1d: ep.uptime_last_1d ?? null,
  };
}

function publicTarget(t) {
  const { provider, model, ...rest } = t;
  return { ...rest, model };
}

function requiredParams(suite) {
  const s = new Set();
  for (const c of suite.cases) {
    if (c.tools) s.add("tools");
    if (c.tool_choice) s.add("tool_choice");
    if (c.response_format) s.add("response_format");
  }
  return [...s];
}

function estimateCost(kase, price) {
  const promptTokens = Math.ceil(JSON.stringify([kase.messages, kase.tools ?? []]).length / 3); // conservative chars→tokens
  const completionTokens = kase.max_tokens ?? 1024;
  return promptTokens * price.prompt + completionTokens * price.completion;
}

function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
