import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { adrRecordDrops, resetChangelog, rewriteDroppedAdrLinks } from "./clean.mjs";
import { ROOT } from "./init.mjs";
import { PROVENANCE_FILE } from "../scripts/template-source.mjs";
import { sourceFixture } from "./test-source.mjs";

let source;
before(() => { source = sourceFixture(ROOT); });
after(() => rmSync(source, { recursive: true, force: true }));

test("adrRecordDrops keeps the seed files and drops every numbered record", () => {
  const tracked = ["docs/adr/README.md", "docs/adr/0000-template.md", "docs/adr/0001-a.md", "docs/adr/0040-b.md", "docs/adr/notes.md", "docs/adr/sub/0005-c.md", "docs/README.md"];
  assert.deepEqual([...adrRecordDrops(tracked)].sort(), ["docs/adr/0001-a.md", "docs/adr/0040-b.md"]);
});

test("resetChangelog keeps the header and the Unreleased heading, drops pending entries", () => {
  const input = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- template stuff ([ADR-0040](docs/adr/0040-b.md))\n\n## [3.17.1] - 2026-11-03\n";
  assert.equal(resetChangelog(input), "# Changelog\n\n## [Unreleased]\n");
  assert.throws(() => resetChangelog("# Changelog\n"), /Unreleased/);
});

test("rewriteDroppedAdrLinks keeps the label as plain text outside the index", () => {
  const drops = new Set(["docs/adr/0005-x.md"]);
  const out = rewriteDroppedAdrLinks("See [ADR-0005](adr/0005-x.md) and [ADR-0005 again](adr/0005-x.md#section).", "docs/guide.md", drops);
  assert.equal(out, "See ADR-0005 and ADR-0005 again.");
});

test("rewriteDroppedAdrLinks resolves relative links from the linking file", () => {
  const drops = new Set(["docs/adr/0007-y.md"]);
  const out = rewriteDroppedAdrLinks("Ported as [ADR-0007](../../../docs/adr/0007-y.md).", ".claude/skills/a/SKILL.md", drops);
  assert.equal(out, "Ported as ADR-0007.");
});

test("rewriteDroppedAdrLinks drops a whole index row but leaves code alone", () => {
  const drops = new Set(["docs/adr/0009-z.md"]);
  const index = "| [0008](0008-a.md) | kept | Accepted |\n| [0009](0009-z.md) | dropped | Proposed |\n";
  assert.equal(rewriteDroppedAdrLinks(index, "docs/adr/README.md", drops), "| [0008](0008-a.md) | kept | Accepted |\n");
  const doc = "text [ADR-0009](adr/0009-z.md)\n\n```\n[ADR-0009](adr/0009-z.md)\n```\n\ninline `[ADR-0009](adr/0009-z.md)` stays\n";
  const out = rewriteDroppedAdrLinks(doc, "docs/README.md", drops);
  assert.equal(out, "text ADR-0009\n\n```\n[ADR-0009](adr/0009-z.md)\n```\n\ninline `[ADR-0009](adr/0009-z.md)` stays\n");
});

test("rewriteDroppedAdrLinks leaves URLs, anchors, images and other links alone", () => {
  const drops = new Set(["docs/adr/0005-x.md"]);
  const input = "[ext](https://example.com/docs/adr/0005-x.md) [anchor](#adr/0005-x.md) ![img](adr/0005-x.md) [keep](adr/0000-template.md) [rel](./other.md \"title\")";
  assert.equal(rewriteDroppedAdrLinks(input, "docs/README.md", drops), input);
});

for (const preset of ["minimal", "all"]) {
  test(`preset ${preset}: generated project has a fresh decision log and no template meta residue`, (t) => {
    const out = join(mkdtempSync(join(tmpdir(), "clean-")), "project");
    t.after(() => rmSync(dirname(out), { recursive: true, force: true }));
    execFileSync("node", ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--preset", preset, "--out", out], { cwd: ROOT, stdio: "pipe" });
    execFileSync("git", ["init", "-q"], { cwd: out });
    execFileSync("git", ["add", "-A"], { cwd: out });
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: out, encoding: "utf8" }).split("\0").filter(Boolean);

    // The decision log starts empty: only the index and the template record remain.
    assert.deepEqual(readdirSync(join(out, "docs/adr")).sort(), ["0000-template.md", "README.md"]);
    const index = readFileSync(join(out, "docs/adr/README.md"), "utf8");
    assert.doesNotMatch(index, /\|\s*\[\d{4}\]\(/, "ADR index still links a dropped record");

    // No kept document links a dropped record.
    for (const file of tracked.filter((f) => f.endsWith(".md"))) {
      assert.doesNotMatch(readFileSync(join(out, file), "utf8"), /\]\([^)]*docs\/adr\/(?!0000-)\d{4}[^)]*\)/, `${file} links a dropped ADR`);
    }

    // No changelog is created; the provenance record is the origin (ADR-0041).
    assert.equal(existsSync(join(out, "CHANGELOG.md")), false, "init must not create a CHANGELOG");
    const provenance = JSON.parse(readFileSync(join(out, PROVENANCE_FILE), "utf8"));
    assert.equal(provenance.schemaVersion, 2);
    assert.match(provenance.source.commit, /^[0-9a-f]{40}$/);

    // The template's own agent adapters do not ship.
    assert.equal(existsSync(join(out, ".github/agents")), false, ".github/agents survived");

    // Identity survives only where it is the provenance record itself.
    const allowed = new Set([".template-provenance.json", "LICENSE"]);
    for (const file of tracked) {
      if (allowed.has(file)) continue;
      const text = readFileSync(join(out, file), "utf8");
      assert.ok(!text.includes("ULTRA-TEMPLATE") && !text.includes("Ultra-Solo"), `${file} names the template identity`);
    }

    // A template copy's git history is one fresh initial commit.
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "chore: initialize project"], { cwd: out });
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: out, encoding: "utf8" }).trim(), "1");

    // The project's own checks pass with the dropped records gone.
    for (const check of ["scripts/check-hygiene.mjs", "scripts/check-docs.mjs"]) {
      assert.doesNotThrow(() => execFileSync("node", [check], { cwd: out, stdio: "pipe" }), check);
    }
  });
}
