// The cadence table must be read from the workflows, never recalled. A schedule remembered rather than
// read is a trigger that never gets checked, so this holds the two together: the table in
// template/release-cadence.md and the `cron:` lines in .github/workflows/ must name the same schedules.
// Both live under template/, so a project initialized from here keeps neither and needs neither.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/modules.mjs";

export const PLAN = "template/release-cadence.md";
const WORKFLOWS = join(ROOT, ".github", "workflows");

/** A cron is five whitespace-separated fields; anything else that looks like one is a typo. */
const CRON = /(?:^|[\s`"'])((?:[0-9*/,?-]+\s+){4}(?:[0-9*/,?-]+))(?=$|[\s`"',])/g;

export const crons = (text) => [...text.matchAll(CRON)].map(([, cron]) => cron.trim().replace(/\s+/g, " "));

/** Every scheduled workflow, as `{ workflow, cron }`, read from the files rather than from a list. */
export function schedules(dir = WORKFLOWS) {
  const found = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const [, value] = /^\s*-\s*cron:\s*["']?([^"'\n]+?)["']?\s*$/.exec(line) ?? [];
      if (value) found.push({ workflow: name, cron: value.trim().replace(/\s+/g, " ") });
    }
  }
  return found;
}

/** Every way the table and the workflows disagree. */
export function compare(planText, entries) {
  const failures = [];
  const documented = new Set(crons(planText));
  const scheduled = new Set(entries.map((e) => e.cron));
  for (const { workflow, cron } of entries) {
    if (!documented.has(cron)) {
      failures.push(`\`${workflow}\` runs \`${cron}\`, which \`${PLAN}\` does not list. Read the schedule from the file and add its row.`);
    }
  }
  for (const cron of documented) {
    if (!scheduled.has(cron)) {
      failures.push(`\`${PLAN}\` lists \`${cron}\`, which no workflow in .github/workflows runs. A table of schedules nothing has is a trigger that never fires.`);
    }
  }
  return failures;
}

test("every scheduled workflow appears in the plan, and the plan invents no schedule", () => {
  const entries = schedules();
  assert.ok(entries.length > 0, "no scheduled workflow was found, so this check compared nothing");
  assert.deepEqual(compare(readFileSync(join(ROOT, PLAN), "utf8"), entries), []);
});

test("a schedule missing from the plan is reported, naming the workflow", () => {
  const failures = compare("| T | x | y | `23 6 * * 2` |", [{ workflow: "pins.yml", cron: "23 6 * * 2" }, { workflow: "codeql.yml", cron: "23 4 * * 1" }]);
  assert.deepEqual(failures, ["`codeql.yml` runs `23 4 * * 1`, which `template/release-cadence.md` does not list. Read the schedule from the file and add its row."]);
});

test("a schedule the plan keeps but no workflow has is reported", () => {
  const failures = compare("| T | x | y | `23 6 * * 2` and `0 0 * * 0` |", [{ workflow: "pins.yml", cron: "23 6 * * 2" }]);
  assert.deepEqual(failures, ["`template/release-cadence.md` lists `0 0 * * 0`, which no workflow in .github/workflows runs. A table of schedules nothing has is a trigger that never fires."]);
});

test("a cron with different spacing is the same schedule", () => {
  assert.deepEqual(compare("`23  6 * * 2`", [{ workflow: "pins.yml", cron: "23 6 * * 2" }]), []);
});

test("the only schedules the plan documents are the five the workflows run", () => {
  assert.deepEqual(schedules().map((e) => `${e.cron} ${e.workflow}`).sort(), [
    "17 6 * * 1 template-test.yml",
    "23 4 * * 1 codeql.yml",
    "23 6 * * 2 pins.yml",
    "37 5 * * 1 scorecard.yml",
    "41 5 * * 1 security.yml",
  ]);
});
