// Shapes of the events runBench emits and the report it returns. lib/ stays
// plain JS so the CLI runs with no build step; these types are for the UI.

export type Target = {
  id: string;
  label: string;
  kind: "provider" | "baseline";
  model: string;
  quantization?: string;
  price: { prompt: number; completion: number };
};

export type CaseInfo = { id: string; description?: string };

export type Plan = {
  type: "plan";
  model: string;
  runs: number;
  cases: CaseInfo[];
  targets: Target[];
  skipped: { id: string; reason: string }[];
  estimate: number | null;
};

export type Result = {
  type?: "result";
  targetId: string;
  caseId: string;
  run: number;
  pass: boolean;
  failure?: string;
  detail?: string;
  servedBy?: string | null;
  ttftMs?: number | null;
  totalMs?: number;
  cost?: number | null;
  output?: string;
  toolCalls?: { name: string; arguments: string }[];
};

export type Summary = Target & {
  unavailable: boolean;
  n: number;
  passRate: number | null;
  qualityRate: number | null;
  availability: number | null;
  failures: Record<string, number>;
  servedBy: Record<string, number>;
  p50TtftMs: number | null;
  p50TokensPerSec: number | null;
  avgCost: number | null;
};

export type CaseStat = CaseInfo & { passRate: number | null; failingProviders: string[]; verdict: string };

export type Recommendation = { provider: Record<string, unknown>; reasons: string[]; caveat?: string };

export type Done = {
  type: "done";
  model: string;
  summary: Summary[];
  cases?: CaseStat[];
  recommendation: Recommendation;
  spent: number;
  aborted: string | null;
};

export type Report = Omit<Plan, "type" | "estimate"> & Omit<Done, "type"> & { results: Result[]; ranAt: string };

export type BenchEvent = Plan | (Result & { type: "result" }) | { type: "unavailable"; targetId: string } | Done | { type: "error"; message: string };
