import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

// scripts/check-plan.mjs exports no functions: its contract is the process it starts,
// because that is how scripts/verify.mjs runs it as the `chassis: plan` step. These
// cases drive that process, so a change that stops it failing fails here.
const CHECK_PLAN = fileURLToPath(new URL("../scripts/check-plan.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const roots = [];

/** A temporary root holding data/plan.md, or no plan file at all when content is null. */
function planRoot(content) {
  const root = mkdtempSync(join(tmpdir(), "check-plan-"));
  roots.push(root);
  mkdirSync(join(root, "data"), { recursive: true });
  if (content !== null) writeFileSync(join(root, "data", "plan.md"), content);
  return root;
}

function runPlan(args, options = {}) {
  return spawnSync(process.execPath, [CHECK_PLAN, ...args], { encoding: "utf8", ...options });
}

/** One well-formed entry, so a case can change exactly one thing about it. */
function entry(overrides = {}) {
  const f = {
    id: "gate-setup",
    status: "done",
    trigger: "a cause",
    verdict: "a determination",
    ...overrides,
  };
  const lines = [
    `### ${f.id}`,
    `- id: ${f.id}`,
    `- status: ${f.status}`,
    `- trigger: ${f.trigger}`,
    `- verdict: ${f.verdict}`,
  ];
  if (f.evidence !== null) {
    lines.push("- evidence:", ...(f.evidence ?? ["    PASS node scripts/check-plan.mjs"]));
  }
  if (f.open_issue !== undefined) lines.push(`- open_issue: ${f.open_issue}`);
  return lines.join("\n") + "\n";
}

function plan(...entries) {
  return ["# Plan", "", "## Entries", "", ...entries].join("\n");
}

const FENCED_TEMPLATE = ["```", "### <id>", "- status: <pending | done>", "```", ""].join("\n");

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("check-plan accepts a well-formed plan", () => {
  it("exits 0 and reports the entry count", () => {
    const r = runPlan([planRoot(plan(entry()))]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /plan schema OK, 1 entry\/entries/);
  });

  it("accepts a blocked entry whose open_issue is an issue of this repository", () => {
    const r = runPlan([
      planRoot(
        plan(
          entry({
            status: "blocked",
            open_issue: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE/issues/1",
          }),
        ),
      ),
    ]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("accepts an empty open_issue on an entry that is not blocked", () => {
    const r = runPlan([planRoot(plan(entry({ status: "pending", open_issue: "" })))]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("reads the root from argv, not from the working directory", () => {
    const r = runPlan([planRoot(plan(entry()))], { cwd: tmpdir() });
    assert.equal(r.status, 0, r.stderr);
  });

  it("falls back to the working directory when argv names no root", () => {
    const root = planRoot(plan(entry()));
    const r = runPlan([], { cwd: root });
    assert.equal(r.status, 0, r.stderr);
  });

  it("validates the repository's own data/plan.md", () => {
    const r = runPlan([REPO_ROOT]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /plan schema OK, \d+ entry\/entries/);
  });
});

describe("check-plan fails a plan that drifts", () => {
  const cases = [
    ["a plan with no entries", "# Plan\n\nNothing to see.\n", /has no entries/],
    ["an empty plan file", "", /plan.md is missing/],
    ["a non-kebab id", plan(entry({ id: "gate_setup" })), /id must be a non-empty kebab-case identifier/],
    ["an unknown status", plan(entry({ status: "finished" })), /status must be one of/],
    ["a missing trigger", plan(entry({ trigger: "" })), /trigger is required and non-empty/],
    ["a missing verdict", plan(entry({ verdict: "" })), /verdict is required and non-empty/],
    ["no evidence lines", plan(entry({ evidence: null })), /evidence is required/],
    [
      "an evidence line without a recognized prefix",
      plan(entry({ evidence: ["    TODO do the thing"] })),
      /evidence line not prefixed with PASS \| FAIL \| COMMIT \| CI \| PR \| CLONE/,
    ],
    [
      "evidence indented less than four spaces",
      plan(entry({ evidence: ["  PASS node scripts/check-plan.mjs"] })),
      /evidence is required/,
    ],
    [
      "a blocked entry with no open_issue",
      plan(entry({ status: "blocked" })),
      /status=blocked requires open_issue to be a valid GitHub issue URL/,
    ],
    [
      "a blocked entry whose open_issue belongs to another repository",
      plan(entry({ status: "blocked", open_issue: "https://github.com/other/repo/issues/1" })),
      /status=blocked requires open_issue to be a valid GitHub issue URL/,
    ],
    [
      "an open_issue on an entry that is not blocked",
      plan(entry({ status: "pending", open_issue: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE/issues/1" })),
      /open_issue is only required for status=blocked; clear it for status=pending/,
    ],
  ];

  for (const [name, content, expected] of cases) {
    it(`exits 1 for ${name}`, () => {
      const r = runPlan([planRoot(content)]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, expected);
    });
  }

  it("exits 1 for a duplicate id and names it", () => {
    const r = runPlan([planRoot(plan(entry(), entry({ trigger: "another cause" })))]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /duplicate id "gate-setup"/);
  });

  it("reports every violation of one entry, not only the first", () => {
    const r = runPlan([planRoot(plan(entry({ id: "Bad_Id", status: "finished", trigger: "" })))]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /id must be a non-empty kebab-case identifier/);
    assert.match(r.stderr, /status must be one of/);
    assert.match(r.stderr, /trigger is required and non-empty/);
  });
});

describe("check-plan reads the plan's structure", () => {
  it("ignores a fenced entry template instead of reading it as an entry", () => {
    const r = runPlan([planRoot(plan(FENCED_TEMPLATE))]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /has no entries/);
  });

  it("still counts the real entries around a fenced template", () => {
    const r = runPlan([planRoot(plan(FENCED_TEMPLATE, entry()))]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /plan schema OK, 1 entry\/entries/);
  });

  it("closes an entry at a level-2 heading and counts the next one", () => {
    const content = plan(entry(), "## Later", "", entry({ id: "minimal-pr" }));
    const r = runPlan([planRoot(content)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /plan schema OK, 2 entry\/entries/);
  });
});

describe("check-plan cannot read the plan", () => {
  it("exits 2 when data/plan.md is absent", () => {
    const r = runPlan([planRoot(null)]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot read plan/);
  });
});
