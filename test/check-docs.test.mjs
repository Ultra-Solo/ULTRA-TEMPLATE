// Every rule gets a case that must fire and the clean fixture that must not. A checker with only
// the passing case proves nothing: it passes just as well when the rule is broken.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkDocs, frontmatter, hookProblems, IMPORT_TEXT, indexStatus, linksTo, markdownLinks, MAX_POINTER_LINES, MAX_SKILL_DESCRIPTION, recordStatus, statusRelations } from "../scripts/check-docs.mjs";

const skill = (name, description = "When to use it.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const CLEAN = {
  "AGENTS.md": "# AGENTS.md\n\nHow to work here.\n",
  "CLAUDE.md": IMPORT_TEXT,
  "GEMINI.md": "See [AGENTS.md](AGENTS.md).\n",
  ".github/copilot-instructions.md": "See [AGENTS.md](../AGENTS.md).\n",
  ".claude/skills/record-decision/SKILL.md": skill("record-decision"),
  "docs/README.md": "# Documentation\n\n- [Decisions](adr/README.md)\n- [Runbook](./runbook.md)\n",
  "docs/runbook.md": "# Runbook\n",
  "docs/adr/README.md": "# Decisions\n\n| [0001](0001-first.md) | Accepted |\n",
  "docs/adr/0001-first.md": "# First\n\n**Status:** Accepted · **Date:** 2026-01-01\n",
};

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), "docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({ ...CLEAN, ...changes })) {
    if (content === null) continue; // a file the case removes
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
  return root;
}

const failures = (t, changes) => checkDocs(fixture(t, changes)).failures.join("\n");

test("a repository whose documentation is in order passes", (t) => {
  const result = checkDocs(fixture(t));
  assert.equal(result.ok, true, result.failures?.join("\n"));
  assert.equal(result.skillCount, 1);
  assert.equal(result.docCount, 4);
});

test("outside a git repository the checker says so instead of passing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "docs-nogit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = checkDocs(root);
  assert.equal(result.ok, false);
  assert.match(result.fatal, /git repository/);
});

test("the instructions are one file: missing, empty or duplicated all fail", (t) => {
  assert.match(failures(t, { "AGENTS.md": null }), /AGENTS\.md` is missing/);
  assert.match(failures(t, { "AGENTS.md": "\n \n" }), /AGENTS\.md` is empty/);
  assert.match(failures(t, { "services/api/AGENTS.md": "# local rules\n" }), /services\/api\/AGENTS\.md.*drifts/s);
});

test("CLAUDE.md must be the import line and nothing else", (t) => {
  assert.match(failures(t, { "CLAUDE.md": `${IMPORT_TEXT}\nAlso: never run the tests.\n` }), /CLAUDE\.md` must be exactly/);
  assert.match(failures(t, { "CLAUDE.md": null }), /CLAUDE\.md` is missing/);
  // A Windows checkout writes CRLF; the file still says exactly the same thing.
  assert.equal(checkDocs(fixture(t, { "CLAUDE.md": IMPORT_TEXT.replaceAll("\n", "\r\n") })).ok, true);
});

test("a vendor pointer that carries its own instructions fails", (t) => {
  assert.match(failures(t, { "GEMINI.md": "Build with npm, deploy on Fridays.\n" }), /GEMINI\.md` never names AGENTS\.md/);
  assert.match(failures(t, { ".github/copilot-instructions.md": null }), /copilot-instructions\.md` is missing/);
  const long = `See [AGENTS.md](AGENTS.md).\n${"filler\n".repeat(MAX_POINTER_LINES)}`;
  assert.match(failures(t, { "GEMINI.md": long }), new RegExp(`over ${MAX_POINTER_LINES}`));
});

test("a skill is selectable: frontmatter, a name matching its directory, a description", (t) => {
  assert.match(failures(t, { ".claude/skills/record-decision/SKILL.md": "# Record a decision\n" }), /has no frontmatter/);
  assert.match(failures(t, { ".claude/skills/record-decision/SKILL.md": skill("record_decision") }), /declares name `record_decision`/);
  // The only skill in this case, because a case-insensitive filesystem would merge it with the clean one.
  assert.match(
    failures(t, { ".claude/skills/record-decision/SKILL.md": null, ".claude/skills/Record_Decision/SKILL.md": skill("Record_Decision") }),
    /must be lowercase words/,
  );
  assert.match(failures(t, { ".claude/skills/record-decision/SKILL.md": "---\nname: record-decision\n---\n" }), /has no description/);
  assert.match(
    failures(t, { ".claude/skills/record-decision/SKILL.md": skill("record-decision", "x".repeat(MAX_SKILL_DESCRIPTION + 1)) }),
    new RegExp(`over the ${MAX_SKILL_DESCRIPTION}`),
  );
  assert.match(failures(t, { ".claude/skills/record-decision/reference.md": "# notes\n", ".claude/skills/record-decision/SKILL.md": null }), /has no SKILL\.md/);
  assert.match(failures(t, { "docs/SKILL.md": skill("docs") }), /outside `\.claude\/skills/);
});

test("a document nothing links to fails, at either level", (t) => {
  assert.match(failures(t, { "docs/queues.md": "# Queues\n" }), /docs\/README\.md` does not link `queues\.md`/);
  assert.match(failures(t, { "docs/adr/0002-second.md": "# Second\n" }), /docs\/adr\/README\.md` does not link `0002-second\.md`/);
  assert.match(failures(t, { "docs/README.md": "# Documentation\n\n- [Runbook](runbook.md)\n" }), /does not link `adr\/README\.md`/);
  assert.match(failures(t, { "docs/adr/README.md": null }), /docs\/adr\/` has no README\.md/);
});

test("the ADR index states each record's status as its record does", (t) => {
  const record = (status) => `# A decision\n\n**Status:** ${status} · **Date:** 2026-01-01\n`;
  const index = (...rows) => ["# Decisions", "", "| ADR | Decision | Status |", "|---|---|---|", ...rows, ""].join("\n");
  const first = "| [0001](0001-first.md) | First | Accepted |";
  const second = (status, row, link = "[0002](0002-second.md)", [firstStatus, firstRow] = ["Accepted", "Accepted"]) => ({
    "docs/adr/0001-first.md": record(firstStatus),
    "docs/adr/0002-second.md": record(status),
    "docs/adr/README.md": index(`| [0001](0001-first.md) | First | ${firstRow} |`, `| ${link} | Second | ${row} |`),
  });
  // Each way a record writes its status passes when its row says the same in the index's short form
  // (and, for rule 12, when the record it amends says so back).
  const amended = ["Accepted · Amended by [ADR-0002](0002-second.md)", "Accepted, amended by 0002"];
  for (const [status, row, back] of [
    ["Accepted", "Accepted"],
    ["Accepted · Amends [ADR-0001](0001-first.md)", "Accepted, amends 0001", amended],
    ["Accepted, amends [ADR-0001](0001-first.md)", "Accepted, amends 0001", amended],
  ]) {
    const result = checkDocs(fixture(t, second(status, row, undefined, back)));
    assert.equal(result.ok, true, `${status}: ${result.failures?.join("\n")}`);
  }
  const superseded = {
    "docs/adr/0001-first.md": record("Superseded by [ADR-0002](0002-second.md)"),
    "docs/adr/0002-second.md": record("Accepted · Supersedes [ADR-0001](0001-first.md)"),
    "docs/adr/README.md": index("| [0001](0001-first.md) | First | Superseded by 0002 |", "| [0002](0002-second.md) | Second | Accepted, supersedes 0001 |"),
  };
  assert.equal(checkDocs(fixture(t, superseded)).ok, true, "a superseded record's row names what superseded it");

  assert.match(
    failures(t, second("Accepted, amends [ADR-0001](0001-first.md)", "Accepted")),
    /`docs\/adr\/README\.md` gives 0002 the status "Accepted", but its record says "Accepted, amends 0001"/,
  );
  assert.match(failures(t, { ...superseded, "docs/adr/README.md": index(first, "| [0002](0002-second.md) | Second | Accepted |") }), /gives 0001 the status "Accepted", but its record says "Superseded by 0002"/);
  assert.match(failures(t, { ...second("Accepted", "Accepted"), "docs/adr/0002-second.md": "# Second\n" }), /`docs\/adr\/0002-second\.md` has no `\*\*Status:\*\*` line/);
  assert.match(failures(t, second("Accepted", "Accepted", "[0003](0002-second.md)")), /links `0002-second\.md` as 0003/);
  assert.match(failures(t, second("Accepted · Amends [ADR-0003](0001-first.md)", "Accepted, amends 0003")), /status names ADR-0003 but links `0001-first\.md`/);
});

test("rule 12: a record another amends or supersedes says so, and the other says it back", (t) => {
  const record = (status) => `# A decision\n\n**Status:** ${status} · **Date:** 2026-01-01\n`;
  const pair = (first, second) => ({
    "docs/adr/0001-first.md": record(first),
    "docs/adr/0002-second.md": record(second),
    "docs/adr/README.md": ["# Decisions", "", "| ADR | Decision | Status |", "|---|---|---|", `| [0001](0001-first.md) | First | ${indexStatus(first)} |`, `| [0002](0002-second.md) | Second | ${indexStatus(second)} |`, ""].join("\n"),
  });
  for (const [first, second] of [
    ["Accepted · Amended by [ADR-0002](0002-second.md)", "Accepted · Amends [ADR-0001](0001-first.md)"],
    ["Superseded by [ADR-0002](0002-second.md)", "Accepted · Supersedes [ADR-0001](0001-first.md)"],
  ]) {
    const result = checkDocs(fixture(t, pair(first, second)));
    assert.equal(result.ok, true, `${first} / ${second}: ${result.failures?.join("\n")}`);
  }
  assert.match(
    failures(t, pair("Accepted", "Accepted · Amends [ADR-0001](0001-first.md)")),
    /`docs\/adr\/0001-first\.md` must say "Amended by \[ADR-0002\]\(0002-second\.md\)" on its status line: ADR-0002 says it amends ADR-0001/,
  );
  assert.match(
    failures(t, pair("Accepted · Amended by [ADR-0002](0002-second.md)", "Accepted")),
    /`docs\/adr\/0002-second\.md` must say "Amends \[ADR-0001\]\(0001-first\.md\)" on its status line: ADR-0001 says it is amended by ADR-0002/,
  );
  assert.match(failures(t, pair("Superseded by [ADR-0002](0002-second.md)", "Accepted")), /must say "Supersedes \[ADR-0001\]\(0001-first\.md\)"/);
  assert.match(
    failures(t, pair("Accepted · Amends [ADR-0002](0002-second.md)", "Accepted · Amended by [ADR-0001](0001-first.md)")),
    /`docs\/adr\/0001-first\.md` says it amends ADR-0002, a later record: a record amends or supersedes only the records before it/,
  );
  assert.match(failures(t, pair("Accepted", "Accepted · Amends [ADR-0009](0009-gone.md)")), /`docs\/adr\/0002-second\.md` says it amends ADR-0009, which is not a record here/);
});

test("a status names the records it amends or supersedes, and the ones that amend or supersede it", () => {
  assert.deepEqual(statusRelations("Accepted"), { amends: [], supersedes: [], "amended by": [], "superseded by": [] });
  assert.deepEqual(statusRelations("Accepted · Amends [ADR-0005](a.md), [ADR-0007](b.md) and [ADR-0008](c.md) · Amended by [ADR-0013](d.md)"), {
    amends: ["0005", "0007", "0008"],
    supersedes: [],
    "amended by": ["0013"],
    "superseded by": [],
  });
  assert.deepEqual(statusRelations("Accepted, amends [ADR-0004](a.md) and [ADR-0010](b.md)").amends, ["0004", "0010"]);
  assert.deepEqual(statusRelations("Superseded by [ADR-0017](0017-a.md)")["superseded by"], ["0017"]);
});

test("a record's status is read from its status line and written short, as the index writes it", () => {
  assert.equal(recordStatus("# T\n\n**Status:** Accepted · **Date:** 2026-01-01\n"), "Accepted");
  assert.equal(recordStatus("# T\n\n**Status:** Accepted\n"), "Accepted", "a line without a date is the status alone");
  assert.equal(recordStatus("# T\n\nNo status here.\n"), null);
  // Every form a record in this repository writes, and the template's.
  assert.equal(indexStatus("Accepted"), "Accepted");
  assert.equal(indexStatus("Accepted · Amends [ADR-0006](0006-one-set-of-agent-instructions.md)"), "Accepted, amends 0006");
  assert.equal(indexStatus("Accepted · Amends [ADR-0005](a.md), [ADR-0007](b.md) and [ADR-0008](c.md)"), "Accepted, amends 0005, 0007, 0008");
  assert.equal(indexStatus("Accepted, amends [ADR-0004](a.md) and [ADR-0010](b.md)"), "Accepted, amends 0004, 0010");
  assert.equal(indexStatus("Superseded by [ADR-0017](0017-a.md)"), "Superseded by 0017");
});

test("a repository with no docs directory is not a failure", (t) => {
  const result = checkDocs(fixture(t, { "docs/README.md": null, "docs/runbook.md": null, "docs/adr/README.md": null, "docs/adr/0001-first.md": null }));
  assert.equal(result.ok, true, result.failures?.join("\n"));
  assert.equal(result.docCount, 0);
});

test("a name no tool reads fails, including one that differs only in case", (t) => {
  assert.match(failures(t, { "AGENT.md": "# stray\n" }), /is the singular name/);
  assert.match(failures(t, { "docs/agents.md": "# stray\n" }), /only in case/);
  assert.match(failures(t, { "packages/ui/Claude.md": IMPORT_TEXT }), /only in case/);
});

test("a relative link that goes nowhere fails, and code is not a link", (t) => {
  assert.match(
    failures(t, { "docs/runbook.md": "# Runbook\n\nSee [the plan](plan.md).\n" }),
    /docs\/runbook\.md:3.*plan\.md/,
  );
  // A link to a file that exists, an external URL, and a bare anchor all pass.
  const fine = "# Runbook\n\n[index](README.md) [site](https://example.invalid/x.md) [top](#top)\n";
  assert.equal(checkDocs(fixture(t, { "docs/runbook.md": fine })).ok, true);
  // A link out of the repository fails even when it happens to resolve on this machine: the
  // fixture's own parent directory certainly exists, and it is still not in any clone.
  assert.match(failures(t, { "docs/runbook.md": "# Runbook\n\n[up](../../)\n" }), /outside the repository/);
  // Link syntax quoted as code, or shown in a fence, is documentation about links, not a link.
  const quoted = ["# Runbook", "", "Write `[ADR-NNNN](NNNN-title.md)` with the real number.", "", "```md", "[x](also-missing.md)", "```", ""].join("\n");
  assert.equal(checkDocs(fixture(t, { "docs/runbook.md": quoted })).ok, true);
});

test("a vendor customization file needs its frontmatter and must defer to AGENTS.md", (t) => {
  const prompt = ".github/prompts/verify.prompt.md";
  assert.match(failures(t, { [prompt]: "Run it. See [AGENTS.md](../../AGENTS.md).\n" }), /needs frontmatter with description/);
  assert.match(failures(t, { [prompt]: "---\ndescription: Run it.\n---\n\nAlways skip the tests.\n" }), /never names AGENTS\.md/);
  assert.match(
    failures(t, { ".github/agents/reviewer.agent.md": "---\ndescription: Review.\n---\n\nFollow [AGENTS.md](../../AGENTS.md).\n" }),
    /needs frontmatter with name/,
  );
  assert.match(failures(t, { ".github/prompts/notes.md": "# notes\n" }), /is not a `\.prompt\.md` file/);
});

test("frontmatter and link matching read what they claim to read", () => {
  assert.deepEqual(frontmatter('---\nname: a-b\ndescription: "Quoted: with a colon."\n---\nbody\n'), { name: "a-b", description: "Quoted: with a colon." });
  assert.equal(frontmatter("# no frontmatter\n"), null);
  assert.equal(frontmatter("---\nname: unterminated\n"), null);
  assert.equal(linksTo("see [x](./adr/README.md)", "adr/README.md"), true);
  // A longer path ending in the target is a different document.
  assert.equal(linksTo("see [x](old-runbook.md)", "runbook.md"), false);
  // Inline code is not a link, and a title after the target is not part of it.
  assert.deepEqual(markdownLinks('a [one](x.md) b\n`[two](y.md)`\n[three](z.md "title")'), [
    { target: "x.md", line: 1 },
    { target: "z.md", line: 3 },
  ]);
});

test("a Claude Code hook must be a command, and a script it runs from the repository must be tracked", () => {
  const settings = (command) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
  const tracked = ["scripts/agent-env.mjs"];
  assert.deepEqual(hookProblems(settings('node "$CLAUDE_PROJECT_DIR/scripts/agent-env.mjs"'), tracked), []);
  assert.deepEqual(hookProblems(settings("node ${CLAUDE_PROJECT_DIR}/scripts/agent-env.mjs"), tracked), []);
  assert.match(hookProblems(settings('node "$CLAUDE_PROJECT_DIR/scripts/gone.mjs"'), tracked).join(), /hooks\.SessionStart\[0\]\.hooks\[0\] runs scripts\/gone\.mjs, which is not tracked/);
  assert.match(hookProblems({ hooks: { SessionStart: [{ hooks: [{ type: "prompt" }] }] } }, tracked).join(), /is not \{"type": "command"/);
  assert.match(hookProblems({ hooks: { SessionStart: {} } }, tracked).join(), /hooks\.SessionStart is not a list/);
  assert.deepEqual(hookProblems({}, tracked), []);
});
