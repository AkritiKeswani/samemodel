export function validateSuite(s) {
  if (!s || !Array.isArray(s.cases) || !s.cases.length) throw new Error("suite needs a non-empty `cases` array");
  for (const c of s.cases) {
    if (!c.id || !Array.isArray(c.messages)) throw new Error(`each case needs \`id\` and \`messages\` (bad case: ${JSON.stringify(c).slice(0, 80)})`);
  }
  s.name ??= "custom";
  return s;
}
