// Imported statically (not read from disk) so they ship with the serverless bundle.
import toolCalling from "@/suites/tool-calling.json";
import jsonExtraction from "@/suites/json-extraction.json";
import { validateSuite } from "./validate.js";

const SUITES: Record<string, { name: string; description?: string; cases: unknown[] }> = {
  [toolCalling.name]: toolCalling,
  [jsonExtraction.name]: jsonExtraction,
};

export const suiteList = Object.values(SUITES).map((s) => ({ name: s.name, description: s.description, cases: s.cases.length }));

export function getSuite(name: string) {
  const s = SUITES[name];
  if (!s) throw new Error(`suite not found: ${name}`);
  // Clone: validateSuite mutates, and these objects are shared module state.
  return validateSuite(structuredClone(s));
}

export const suiteJson = (name: string) => JSON.stringify(SUITES[name], null, 2);
