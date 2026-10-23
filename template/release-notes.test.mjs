import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./init.mjs";
import { diffTrees, groupByPreset, NOTES_DIR, previousReleaseTag, render, requiredNotes, walk } from "./release-notes.mjs";

/** A generated project, as a directory of files. */
function tree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("comparing two generated projects reports what was added, deleted and changed", (t) => {
  const before = tree(t, {
    "README.md": "# demo\n",
    "scripts/check-contract.mjs": "contract\n",
    "scripts/verify.mjs": "old\n",
    "CHANGELOG.md": "- Initialized from v1.0.0\n",
  });
  const after = tree(t, {
    "README.md": "# demo\n",
    "scripts/verify.mjs": "new\n",
    "docs/adr/0010-new.md": "decided\n",
    "CHANGELOG.md": "- Initialized from v2.0.0\n",
  });

  assert.deepEqual(diffTrees(before, after), [
    ["A", "docs/adr/0010-new.md"],
    ["D", "scripts/check-contract.mjs"],
    ["M", "scripts/verify.mjs"],
  ]);
  // The origin line differs in every release by definition, and the update rewrites it itself.
  assert.deepEqual(diffTrees(before, before), []);
  assert.deepEqual(walk(after).sort(), ["CHANGELOG.md", "README.md", "docs/adr/0010-new.md", "scripts/verify.mjs"]);
});

test("presets that receive the same files share a section, and one that receives nothing is dropped", () => {
  const contract = [["D", "scripts/check-contract.mjs"], ["M", "scripts/verify.mjs"]];
  const readme = [["M", "README.md"]];
  const groups = groupByPreset([["minimal", contract], ["go-api", readme], ["library", contract], ["mcp", []]]);

  assert.deepEqual(groups.map((g) => g.title), ["minimal, library", "go-api"]);
  assert.deepEqual(groups[0].files, ["D scripts/check-contract.mjs", "M scripts/verify.mjs"]);
});

test("a release that reaches every preset the same way says so once", () => {
  const same = [["M", "SECURITY.md"]];
  const groups = groupByPreset([["minimal", same], ["go-api", same], ["all", same]]);
  assert.deepEqual(groups.map((g) => g.title), ["Every preset"]);
});

test("the notes say what reaches projects, how to take it, and what reaches none", () => {
  const groups = groupByPreset([["minimal", [["M", "SECURITY.md"]]]]);
  const notes = render({ to: "v9.9.9", from: "v9.9.8", groups, templateOnly: ["M template/README.md"] });

  assert.match(notes, /## What changes in generated projects\n\n[^\n]+\n\n### Every preset\n\n- `M SECURITY\.md`/);
  assert.match(notes, /template-update\.mjs --to v9\.9\.9 --dry-run/);
  assert.match(notes, /## Reaches no project[\s\S]*`M template\/README\.md`/);
});

test("a release that changes nothing any project has says so, and a new preset is named", () => {
  const notes = render({ to: "v9.9.9", from: "v9.9.8", groups: [], templateOnly: ["M template/init.mjs"], addedPresets: ["rust-api"] });
  assert.match(notes, /Nothing: no file changes in a project made from any preset\./);
  assert.match(notes, /New in this release: the preset\(s\) rust-api\./);
});

test("the first release has nothing to compare against, so it says how to start instead", () => {
  const notes = render({ to: "v1.0.0", from: null, groups: [] });
  assert.match(notes, /^The first release of this template\./);
  assert.match(notes, /node template\/init\.mjs --list/);
  assert.doesNotMatch(notes, /Changes since|template-update/);
});

test("a release's notes for adopters come first, and a minor or major release must have them", () => {
  const notes = "Rule 17 is new: a toolchain version copied anywhere must match its declaration.";
  const out = render({ to: "v2.1.0", from: "v2.0.0", groups: [], notes });
  assert.ok(out.indexOf("## What you need to know") < out.indexOf("## What changes in generated projects"));
  assert.ok(out.includes(notes));
  assert.ok(!render({ to: "v2.0.1", from: "v2.0.0", groups: [] }).includes("What you need to know"));
  assert.equal(requiredNotes("2.1.0"), `${NOTES_DIR}/v2.1.0.md`);
  assert.equal(requiredNotes("3.0.0"), `${NOTES_DIR}/v3.0.0.md`);
  assert.equal(requiredNotes("2.1.3"), null, "a patch release needs none");
  assert.equal(requiredNotes("1.1.0"), null, "nor a release from before the notes began");
});

test("this version has the notes it needs", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, "template/features.json"), "utf8"));
  const file = requiredNotes(version);
  if (file === null) return;
  assert.ok(existsSync(join(ROOT, file)), `${file} is missing: a minor or major release says what adopters need to know`);
  assert.ok(readFileSync(join(ROOT, file), "utf8").trim().length > 0, `${file} is empty`);
});

test("the lower bound is the release before --to, before and after that release is tagged", () => {
  const tags = ["v1.0.0", "v1.1.0", "v2.0.0"];
  assert.equal(previousReleaseTag(tags, "v2.0.0"), "v1.1.0", "publishing --to must not move the bound onto --to itself");
  assert.equal(previousReleaseTag(["v1.0.0", "v1.1.0"], "v2.0.0"), "v1.1.0", "--to is not tagged yet");
  assert.equal(previousReleaseTag(tags, "v1.0.1"), "v1.0.0");
  assert.equal(previousReleaseTag(tags, "v1.0.0"), null, "a first release has nothing before it");
  assert.equal(previousReleaseTag(["v1.0.0", "v1.0.0-rc1"], "v1.0.1"), "v1.0.0", "a tag outside the release format orders nothing");
});
