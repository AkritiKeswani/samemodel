/**
 * Turn a bench summary into a provider routing config you can paste into
 * your OpenRouter request.
 *
 * Design choices (each one is a lesson from how this fails in production):
 *  - allow_fallbacks stays TRUE. Pinning a short provider list with fallbacks
 *    off turns one provider's rate limit into your outage.
 *  - `ignore` is driven by *quality* failures only (broken tool calls, empty
 *    replies, invalid JSON). Being rate-limited during a 2-minute bench is
 *    not evidence a provider is bad; returning malformed tool calls is.
 *  - `order` is a short preference list (top 3), not an allowlist.
 */
export function recommend(summary, { priority = "quality", minQuality = 0.9, ignoreBelow = 0.7, needsParams = false } = {}) {
  const providers = summary.filter((s) => s.kind === "provider" && s.n > 0);
  const answered = providers.filter((s) => s.qualityRate != null);
  // Small samples lie: a provider that answered 2 of 10 calls (both correct)
  // shows "100% quality". Only rank providers that answered at least half
  // the time; the rest stay eligible as fallbacks but aren't preferred.
  const reliable = answered.filter((s) => s.availability >= 0.5);
  const flaky = answered.filter((s) => s.availability < 0.5);

  const good = reliable.filter((s) => s.qualityRate >= minQuality);
  const pool = good.length ? good : [...reliable].sort((a, b) => b.qualityRate - a.qualityRate).slice(0, 3);

  const by = {
    quality: (a, b) => b.qualityRate - a.qualityRate || b.availability - a.availability || (a.avgCost ?? Infinity) - (b.avgCost ?? Infinity),
    cost: (a, b) => (a.avgCost ?? Infinity) - (b.avgCost ?? Infinity) || b.qualityRate - a.qualityRate,
    latency: (a, b) => (a.p50TtftMs ?? Infinity) - (b.p50TtftMs ?? Infinity) || b.qualityRate - a.qualityRate,
  }[priority];
  if (!by) throw new Error(`unknown priority "${priority}" (quality | cost | latency)`);

  const ranked = [...pool].sort(by);
  const order = ranked.slice(0, 3).map((s) => s.id);
  const ignore = answered.filter((s) => s.qualityRate < ignoreBelow).map((s) => s.id);

  const provider = { order, allow_fallbacks: true };
  if (ignore.length) provider.ignore = ignore;
  if (needsParams) provider.require_parameters = true;

  const reasons = [];
  for (const s of ranked.slice(0, 3)) reasons.push(`prefer ${s.id}: ${pct(s.qualityRate)} quality, ${ms(s.p50TtftMs)} TTFT, ${usd(s.avgCost)}/call`);
  for (const id of ignore) {
    const s = answered.find((x) => x.id === id);
    reasons.push(`ignore ${id}: ${pct(s.qualityRate)} quality (${topFailures(s.failures)})`);
  }
  for (const s of flaky) if (!ignore.includes(s.id)) reasons.push(`not preferred ${s.id}: only answered ${pct(s.availability)} of calls (${topFailures(s.failures)}), too little evidence`);
  if (!good.length) reasons.push(`warning: no provider reached ${pct(minQuality)} on this suite — consider a different model`);

  const def = summary.find((s) => s.id === "default");
  const best = ranked[0];
  const comparison = def && best && def.n > 0
    ? { defaultPassRate: def.passRate, recommendedPassRate: best.passRate, defaultAvgCost: def.avgCost, recommendedAvgCost: best.avgCost }
    : null;

  return { provider, reasons, comparison, priority };
}

const AVAIL = new Set(["timeout", "rate_limited", "provider_error", "no_endpoint", "network_error", "bad_request", "out_of_credits"]);
function topFailures(f = {}) {
  // Quality failures first: they're why a provider gets ignored.
  return Object.entries(f).sort((a, b) => AVAIL.has(a[0]) - AVAIL.has(b[0]) || b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(", ");
}
export const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
export const ms = (x) => (x == null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`);
export const usd = (x) => (x == null ? "—" : x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(3)}`);
