import SameModel from "./SameModel";
import { suiteList, suiteJson } from "@/lib/builtin-suites";

// Saved runs in public/replays/: real results, replayed without spending credits.
const REPLAYS = [
  { file: "gpt-oss-120b-tool-calling.json", label: "gpt-oss-120b · tool-calling" },
  { file: "gpt-oss-120b-json-extraction.json", label: "gpt-oss-120b · json-extraction" },
  { file: "deepseek-v3.2-tool-calling.json", label: "deepseek-v3.2 · tool-calling" },
];

// Rendered per request so serverKey reflects the running environment.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <SameModel
      suites={suiteList}
      suiteSources={Object.fromEntries(suiteList.map((s) => [s.name, suiteJson(s.name)]))}
      replays={REPLAYS}
      serverKey={Boolean(process.env.OPENROUTER_API_KEY)}
    />
  );
}
