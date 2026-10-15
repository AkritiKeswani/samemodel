import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";

const DIR = join(ROOT, "suites");

export function listSuites() {
  return readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => {
    const s = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    return { name: s.name, description: s.description, cases: s.cases.length };
  });
}

/** Accepts a suite name ("tool-calling") or a path to a JSON file. */
export function loadSuite(nameOrPath) {
  const path = existsSync(nameOrPath) ? nameOrPath : join(DIR, `${nameOrPath}.json`);
  if (!existsSync(path)) throw new Error(`suite not found: ${nameOrPath}`);
  return validateSuite(JSON.parse(readFileSync(path, "utf8")));
}

export function validateSuite(s) {
  if (!s || !Array.isArray(s.cases) || !s.cases.length) throw new Error("suite needs a non-empty `cases` array");
  for (const c of s.cases) {
    if (!c.id || !Array.isArray(c.messages)) throw new Error(`each case needs \`id\` and \`messages\` (bad case: ${JSON.stringify(c).slice(0, 80)})`);
  }
  s.name ??= "custom";
  return s;
}
