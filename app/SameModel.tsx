"use client";

import { useRef, useState } from "react";
import type { BenchEvent, Done, Plan, Report, Result } from "@/lib/types";

const pct = (x: number | null | undefined) => (x == null ? "—" : Math.round(x * 100) + "%");
const ms = (x: number | null | undefined) => (x == null ? "—" : x >= 1000 ? (x / 1000).toFixed(1) + "s" : x + "ms");
const usd = (x: number | null | undefined) => (x == null ? "—" : x < 0.01 ? "$" + x.toFixed(5) : "$" + x.toFixed(3));
const AVAIL = new Set(["timeout", "rate_limited", "provider_error", "no_endpoint", "network_error", "bad_request", "out_of_credits"]);
const MODELS = ["openai/gpt-oss-120b", "moonshotai/kimi-k2-0905", "deepseek/deepseek-v3.2", "qwen/qwen3-coder", "z-ai/glm-4.6", "meta-llama/llama-3.3-70b-instruct"];
const REPLAY_MS = 6000;

const cellKey = (t: string, c: string, r: number) => `${t}|${c}|${r}`;
const dotClass = (r?: Result) => "dot" + (!r ? "" : r.pass ? " pass" : AVAIL.has(r.failure ?? "") ? " avail" : " fail");

type Props = {
  suites: { name: string; cases: number }[];
  suiteSources: Record<string, string>;
  replays: { file: string; label: string }[];
  serverKey: boolean;
};

export default function SameModel({ suites, suiteSources, replays, serverKey }: Props) {
  const [form, setForm] = useState({ model: "openai/gpt-oss-120b", suite: "tool-calling", runs: "3", priority: "quality", maxSpend: "0.5" });
  const [key, setKey] = useState("");
  const [custom, setCustom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ msg: "", err: false });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cells, setCells] = useState<Record<string, Result>>({});
  const [dimmed, setDimmed] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done | null>(null);
  const [tip, setTip] = useState<{ r: Result; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const counter = useRef({ n: 0, total: 0 });

  const say = (msg: string, err = false) => setStatus({ msg, err });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  function reset() {
    setPlan(null); setCells({}); setDimmed(new Set()); setDone(null); setTip(null);
  }

  function handle(e: BenchEvent) {
    if (e.type === "plan") {
      setPlan(e);
      counter.current = { n: 0, total: e.targets.length * e.cases.length * e.runs };
      const skipped = e.skipped.length ? ` · skipped ${e.skipped.map((s) => s.id).join(", ")} (${e.skipped[0].reason})` : "";
      say(`${e.targets.length} targets × ${e.cases.length} cases × ${e.runs} runs = ${counter.current.total} calls${e.estimate != null ? ` · worst-case ≤ ${usd(e.estimate)}` : ""}${skipped}`);
    } else if (e.type === "result") {
      counter.current.n++;
      setCells((c) => ({ ...c, [cellKey(e.targetId, e.caseId, e.run)]: e }));
      say(`${counter.current.n} / ${counter.current.total} calls…`);
    } else if (e.type === "unavailable") {
      setDimmed((d) => new Set(d).add(e.targetId));
    } else if (e.type === "done") {
      setDone(e);
      say(`Done · spent ${usd(e.spent)}${e.aborted ? " · " + e.aborted : ""}`);
    } else if (e.type === "error") {
      say(e.message, true);
    }
  }

  async function run(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true); reset();
    say("Looking up providers…");
    const body: Record<string, string> = { ...form };
    if (custom?.trim()) body.suiteJson = custom;
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key.trim() ? { "x-openrouter-key": key.trim() } : {}) },
        body: JSON.stringify(body),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (line.startsWith("data: ")) handle(JSON.parse(line.slice(6)));
        }
      }
    } catch (err) {
      say((err as Error).message, true);
    }
    setBusy(false);
  }

  // Feed a saved report through the same event handler a live run uses,
  // spread over a few seconds so the grid fills the way it does live.
  async function replay(file: string) {
    setBusy(true); reset();
    say("Loading replay…");
    try {
      const r: Report = await (await fetch(`/replays/${file}`)).json();
      handle({ type: "plan", model: r.model, runs: r.runs, cases: r.cases ?? [], targets: r.targets, skipped: r.skipped, estimate: null });
      const step = REPLAY_MS / r.results.length;
      for (let i = 0; i < r.results.length; i++) {
        handle({ ...r.results[i], type: "result" });
        if (i % 4 === 3) await new Promise((ok) => setTimeout(ok, step * 4));
      }
      for (const s of r.summary) if (s.unavailable) handle({ type: "unavailable", targetId: s.id });
      handle({ type: "done", model: r.model, summary: r.summary, cases: r.cases, recommendation: r.recommendation, spent: r.spent, aborted: r.aborted });
      setStatus((s) => ({ ...s, msg: s.msg + ` · replay of a real run from ${new Date(r.ranAt).toLocaleString()}` }));
    } catch (err) {
      say((err as Error).message, true);
    }
    setBusy(false);
  }

  function toggleCustom() {
    setCustom(custom === null ? suiteSources[form.suite] ?? "" : null);
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const showTip = (r: Result | undefined) => (e: React.MouseEvent) => setTip(r ? { r, x: e.clientX, y: e.clientY } : null);

  const def = done?.summary.find((s) => s.id === "default");
  const recText = done ? JSON.stringify({ model: done.model, provider: done.recommendation.provider }, null, 2) : "";

  return (
    <main>
      <h1>SameModel <span>· same model, different provider, different answers</span></h1>
      <p className="lede">
        An open model on OpenRouter is usually served by several providers, each with its own quantization, inference stack and tool-call parser. This runs <em>your</em> test cases against every provider serving a model, side by side with OpenRouter&apos;s default routing and <code>:exacto</code>, then writes the <code>provider</code> routing config for you.
      </p>

      <section className="panel">
        <form onSubmit={run}>
          <div>
            <label>Model</label>
            <input list="models" value={form.model} onChange={set("model")} spellCheck={false} />
            <datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div>
            <label>Suite</label>
            <select value={form.suite} onChange={(e) => { setForm({ ...form, suite: e.target.value }); setCustom(null); }}>
              {suites.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.cases} cases)</option>)}
            </select>
          </div>
          <div><label>Runs / case</label><input type="number" min={1} max={5} value={form.runs} onChange={set("runs")} /></div>
          <div>
            <label>Optimize for</label>
            <select value={form.priority} onChange={set("priority")}>
              <option value="quality">quality</option><option value="cost">cost</option><option value="latency">latency</option>
            </select>
          </div>
          <div><label>Max spend ($)</label><input type="number" step={0.05} min={0.05} max={2} value={form.maxSpend} onChange={set("maxSpend")} /></div>
          <button disabled={busy}>Run</button>
        </form>
        <div className="row2">
          {!serverKey && (
            <span>
              API key <input type="password" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />{" "}
              <span style={{ fontSize: 12 }}>Kept in this page&apos;s memory only. The server forwards it to OpenRouter per request and never logs or saves it.</span>
            </span>
          )}
          <button className="ghost" type="button" onClick={toggleCustom}>{custom === null ? "Edit suite JSON" : "Use built-in suite"}</button>
        </div>
        {custom !== null && <textarea spellCheck={false} value={custom} onChange={(e) => setCustom(e.target.value)} />}
        <div className="replays">
          No key? Replay a real run:
          {replays.map((r) => <button key={r.file} className="ghost" type="button" disabled={busy} onClick={() => replay(r.file)}>{r.label}</button>)}
        </div>
      </section>

      <div className={"status" + (status.err ? " err" : "")}>{status.msg}</div>

      {plan && (
        <section className="panel">
          <h2>Live results</h2>
          <div className="scroll">
            <table>
              <tbody>
                <tr>
                  <th>Target</th><th>Quant</th><th className="num">$ / M in·out</th>
                  {plan.cases.map((c) => <th key={c.id} title={c.description}>{c.id}</th>)}
                </tr>
                {plan.targets.map((t) => {
                  const base = t.kind === "baseline";
                  return (
                    <tr key={t.id} className={dimmed.has(t.id) ? "dim" : ""}>
                      <td><div className="tname">{t.label}</div><div className="tsub">{base ? t.model : t.id}</div></td>
                      <td>{base ? <span className="badge base">baseline</span> : <span className="badge">{t.quantization}</span>}</td>
                      <td className="num">{base ? "—" : `${(t.price.prompt * 1e6).toFixed(2)} · ${(t.price.completion * 1e6).toFixed(2)}`}</td>
                      {plan.cases.map((c) => (
                        <td key={c.id}>
                          <span className="dots">
                            {Array.from({ length: plan.runs }, (_, i) => {
                              const r = cells[cellKey(t.id, c.id, i + 1)];
                              return <i key={i} className={dotClass(r)} onMouseMove={showTip(r)} onMouseLeave={() => setTip(null)} />;
                            })}
                          </span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {done?.cases && (
                  <tr>
                    <td colSpan={3}><div className="tname">Providers passing</div><div className="tsub">red = most fail → the model/prompt, not the provider</div></td>
                    {done.cases.map((c) => (
                      <td key={c.id} className="num" style={{ textAlign: "left", color: c.verdict === "model-level" ? "var(--fail)" : "var(--muted)" }}
                        title={c.verdict + (c.failingProviders.length ? ": " + c.failingProviders.join(", ") : "")}>
                        {pct(c.passRate)}{c.verdict === "model-level" ? " · model" : c.verdict === "mixed" ? " · mixed" : ""}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="legend">
            <span><i className="dot pass" />passed</span><span><i className="dot fail" />bad output</span>
            <span><i className="dot avail" />error / rate-limited / timeout</span><span><i className="dot" />pending</span><span>hover a square for details</span>
          </div>
        </section>
      )}

      {done && (
        <>
          <section className="panel">
            <h2>Leaderboard</h2>
            <div className="scroll">
              <table>
                <tbody>
                  <tr><th>Target</th><th>Pass</th><th className="num">Quality</th><th className="num">Avail.</th><th className="num">TTFT p50</th><th className="num">tok/s</th><th className="num">$ / call</th><th>Failures</th></tr>
                  {[...done.summary].sort((a, b) => (b.qualityRate ?? -1) - (a.qualityRate ?? -1)).map((s) => (
                    <tr key={s.id} className={s.unavailable ? "dim" : ""}>
                      <td><div className="tname">{s.label}</div><div className="tsub">{s.kind === "baseline" ? s.model : s.id}{s.unavailable ? " · not available for this model" : ""}</div></td>
                      <td><span className="bar"><i style={{ width: `${(s.passRate ?? 0) * 100}%` }} /></span>{pct(s.passRate)}</td>
                      <td className="num">{pct(s.qualityRate)}</td><td className="num">{pct(s.availability)}</td>
                      <td className="num">{ms(s.p50TtftMs)}</td><td className="num">{s.p50TokensPerSec ?? "—"}</td><td className="num">{usd(s.avgCost)}</td>
                      <td className="fails">{Object.entries(s.failures).map(([k, v]) => `${k}×${v}`).join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {def && Object.keys(def.servedBy).length > 0 && (
              <div className="callout">
                <b>Default routing was actually served by:</b> {Object.entries(def.servedBy).map(([k, v]) => `${k} ×${v}`).join(", ")}. Same model id, different providers, which is why results drift from one request to the next.
              </div>
            )}
          </section>

          <section className="panel">
            <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              Suggested routing (provisional) <button className="ghost" onClick={() => copy(recText)}>{copied ? "Copied" : "Copy"}</button>
            </h2>
            {done.recommendation.caveat && <div className="callout" style={{ margin: "0 0 8px" }}>{done.recommendation.caveat}</div>}
            <pre>{recText}</pre>
            <ul className="reasons">
              {done.recommendation.reasons.map((r) => <li key={r}>{r}</li>)}
              <li>allow_fallbacks stays true on purpose: pinning providers with fallbacks off turns one provider&apos;s rate limit into your outage.</li>
            </ul>
          </section>
        </>
      )}

      {tip && <Tip {...tip} />}
    </main>
  );
}

function Tip({ r, x, y }: { r: Result; x: number; y: number }) {
  const lines = [r.pass ? "✓ passed" : `✗ ${r.failure}${r.detail ? ": " + r.detail : ""}`];
  if (r.servedBy) lines.push(`served by ${r.servedBy}`);
  if (r.ttftMs != null) lines.push(`TTFT ${ms(r.ttftMs)} · total ${ms(r.totalMs)}${r.cost != null ? " · " + usd(r.cost) : ""}`);
  if (r.toolCalls?.length) lines.push("tool: " + r.toolCalls.map((t) => `${t.name}(${t.arguments})`).join(", ").slice(0, 200));
  else if (r.output) lines.push("→ " + r.output.slice(0, 200));
  return (
    <div id="tip" style={{ display: "block", left: Math.min(x + 14, window.innerWidth - 440), top: y + 14 }}>{lines.join("\n")}</div>
  );
}
