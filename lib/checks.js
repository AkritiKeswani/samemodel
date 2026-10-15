// Deterministic checks. Deliberately no LLM-as-judge: a judge model adds its
// own variance and cost, and the failures that actually bite in production
// (empty replies, broken JSON, tool calls leaking out as text) are mechanical
// and can be detected exactly.

// Markup some providers leak into `content` when their tool-call parser
// fails, instead of returning a structured `tool_calls` array.
// (Grown from real runs: e.g. one DeepSeek V3.2 provider returned
// "tool_call_name create_event tool_call_arguments {...}" as plain text.)
const TOOL_MARKUP = /<\/?(tool_call|tool_calls|function_call|use_skills|parameters)\b|<\|tool_call|<function=|\[TOOL_CALLS\]|<｜tool▁call|\btool_call_name\b|\btool_call_arguments\b/i;

/**
 * @param {object} result  { content, toolCalls: [{name, arguments}], finishReason }
 * @param {object} expect  the case's `expect` block
 * @returns {{pass: boolean, failure: string|null, detail: string|null}}
 *   failure is a stable category used for aggregation.
 */
export function evaluate(result, expect = {}) {
  const content = (result.content || "").trim();
  const calls = result.toolCalls || [];

  if (!content && calls.length === 0) return fail("empty", `finish_reason=${result.finishReason ?? "none"}`);
  if (TOOL_MARKUP.test(content)) return fail("tool_markup_leak", snippet(content));

  if (expect.tool_call) {
    const want = expect.tool_call;
    if (calls.length === 0) return fail("missing_tool_call", snippet(content));
    const call = calls.find((c) => c.name === want.name);
    if (!call) return fail("wrong_tool", `called ${calls.map((c) => c.name).join(", ")}`);
    let args;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return fail("invalid_tool_args_json", snippet(call.arguments));
    }
    for (const k of want.required_args || []) {
      if (args[k] === undefined || args[k] === null || args[k] === "") return fail("missing_tool_arg", k);
    }
    for (const [k, pattern] of Object.entries(want.args_match || {})) {
      if (!new RegExp(pattern, "i").test(String(args[k] ?? ""))) return fail("wrong_tool_arg", `${k}=${JSON.stringify(args[k])}`);
    }
  }

  if (expect.no_tool_call && calls.length > 0) return fail("unexpected_tool_call", calls.map((c) => c.name).join(", "));

  if (expect.json) {
    let obj;
    try {
      obj = JSON.parse(stripFences(content));
    } catch {
      return fail("invalid_json", snippet(content));
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return fail("invalid_json", `not a JSON object: ${snippet(content)}`);
    for (const k of expect.json.required_keys || []) {
      if (!(k in obj)) return fail("json_missing_key", k);
    }
    for (const [k, pattern] of Object.entries(expect.json.match || {})) {
      // Stringify the real value: `obj[k] ?? ""` would turn a correct null into "".
      if (!new RegExp(pattern, "i").test(k in obj ? JSON.stringify(obj[k]) : "")) return fail("json_wrong_value", `${k}=${JSON.stringify(obj[k])}`);
    }
  }

  for (const s of expect.contains || []) {
    if (!content.toLowerCase().includes(s.toLowerCase())) return fail("content_mismatch", `missing "${s}"`);
  }
  for (const s of expect.not_contains || []) {
    if (content.toLowerCase().includes(s.toLowerCase())) return fail("content_mismatch", `contains "${s}"`);
  }
  if (expect.regex && !new RegExp(expect.regex, "i").test(content)) return fail("content_mismatch", `no match for /${expect.regex}/`);

  return { pass: true, failure: null, detail: null };
}

/** Map a thrown request error to a failure category. */
export function classifyError(err) {
  if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
  if (err.status === 429) return "rate_limited";
  if (err.status === 402) return "out_of_credits";
  if (err.status === 404) return "no_endpoint";
  if (err.status >= 500 || err.midStream) return "provider_error";
  // A 400 relayed from the provider ("Provider returned error") for a request
  // other providers accept is a compatibility bug, and usually reproducible
  // (Together + null assistant content). Score it as a quality failure, not
  // downtime.
  if (err.status === 400 && /Provider returned error/i.test(err.message)) return "rejects_valid_request";
  if (err.status >= 400) return "bad_request";
  return "network_error";
}

// Failures that say something about the provider's *output quality*, vs.
// failures about availability. Reported separately: a provider that is
// rate-limiting you right now is a different problem from one that
// returns broken tool calls.
export const AVAILABILITY_FAILURES = new Set(["timeout", "rate_limited", "provider_error", "no_endpoint", "network_error", "bad_request", "out_of_credits"]);

function fail(failure, detail) {
  return { pass: false, failure, detail };
}
function snippet(s, n = 140) {
  s = String(s ?? "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
