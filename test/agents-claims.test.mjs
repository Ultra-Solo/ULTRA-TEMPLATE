// AGENTS.md lists the invariants the build enforces. Each is held to what enforces it, so an invariant
// cannot be written down without a check, nor outlive the check that kept it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/modules.mjs";
import { auditLedger, claims, hygieneRules } from "./claims.mjs";

// Only chassis files are cited: every project keeps them, whichever features it has.
const LEDGER = {
  "One required check.": { rules: [9], paths: [".github/workflows/verify.yml", "scripts/configure-github.mjs"] },
  "Pinned supply chain.": { rules: [8, 14, 15, 16, 17], paths: ["scripts/tools/tools.json", "scripts/tools.mjs", ".github/workflows/pins.yml", "scripts/check-pins.mjs"] },
  "Least privilege in workflows.": { rules: [8, 18], paths: [".github/zizmor.yml"] },
  "Repository shape.": { rules: [1, 2, 3, 4, 5, 6, 10, 11, 12] },
  "Independent modules.": { rules: [13], paths: ["scripts/modules.mjs"] },
  "One set of instructions.": { paths: ["scripts/check-docs.mjs"] },
};

const invariants = () => {
  const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const start = text.indexOf("## Invariants the build enforces");
  return claims(text.slice(start, text.indexOf("\n## ", start + 1)));
};

test("every invariant in AGENTS.md names what enforces it, and everything it names is there", () => {
  assert.ok(invariants().length > 0, "AGENTS.md has no invariants section");
  assert.deepEqual(auditLedger(invariants(), LEDGER), []);
});

test("the audit fails on a claim with nothing behind it and on a citation that went away", () => {
  const rules = hygieneRules();
  assert.deepEqual(auditLedger(["A", "B"], { A: { rules: [rules[0]] } }, { rules }), ['"B" names nothing that enforces it']);
  assert.match(auditLedger(["A"], { A: { rules: [99] } }, { rules }).join(), /cites check-hygiene rule 99, which its header does not document/);
  assert.match(auditLedger(["A"], { A: { paths: ["scripts/gone.mjs"] } }, { rules }).join(), /cites scripts\/gone\.mjs, which does not exist/);
  assert.match(auditLedger([], { A: { paths: ["AGENTS.md"] } }, { rules }).join(), /holds "A", which is no longer claimed/);
  assert.match(auditLedger(["A"], { A: {} }, { rules }).join(), /cites neither a rule nor a path/);
});

test("check-hygiene's header numbers its rules 1 to N with none missing or repeated", () => {
  const rules = hygieneRules();
  assert.ok(rules.length > 0, "no numbered rule in check-hygiene's header");
  assert.deepEqual(rules, Array.from({ length: rules.length }, (_, i) => i + 1));
});
