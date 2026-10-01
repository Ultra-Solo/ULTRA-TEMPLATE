import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkGate } from "../scripts/check-hygiene.mjs";
import { ROOT } from "./init.mjs";
import { checkRelease, eventRefs } from "./check-release.mjs";

test("generated-output release checks are required by verify and removed from generated projects", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/verify.yml"), "utf8");
  assert.ok(/^  template-release-check:/m.test(workflow), "the release check job is missing");
  assert.ok(/^      - template-release-check$/m.test(workflow), "the release check is outside the gate");
  assert.deepEqual(checkGate("verify.yml", workflow), []);
  assert.match(checkGate("verify.yml", workflow.replace(/^      - template-release-check\n/m, "")).join("\n"), /template-release-check.*missing/);
});

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Real committed revisions with an initializer that selects a feature and rewrites its content. */
function history(t) {
  const root = mkdtempSync(join(tmpdir(), "release-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "template"));
  const manifest = { version: "2.0.1", identity: { owner: "octo", repo: "template" }, presets: { minimal: [] }, features: { demo: {} } };
  const write = (file, content) => writeFileSync(join(root, file), content);
  const save = () => write("template/features.json", `${JSON.stringify(manifest)}\n`);
  save();
  write("template/init.mjs", `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const features = args[args.indexOf("--features") + 1].split(",").filter(Boolean);
const version = JSON.parse(readFileSync("template/features.json", "utf8")).version;
const transform = (text) => text;
mkdirSync(out);
writeFileSync(join(out, "README.md"), transform(readFileSync("README.md", "utf8")));
writeFileSync(join(out, "CHANGELOG.md"), version);
if (features.includes("demo")) writeFileSync(join(out, "demo.txt"), readFileSync("demo.txt"));
`);
  write("README.md", "original\n");
  write("demo.txt", "feature\n");
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  const commit = () => {
    git(root, "add", "-A");
    git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
    return git(root, "rev-parse", "HEAD").trim();
  };
  const base = commit();
  return { root, base, write, save, manifest, commit, check: () => checkRelease({ root, base, head: "HEAD" }) };
}

test("a generated file cannot change under the old release version", (t) => {
  const h = history(t);
  h.write("README.md", "fixed behavior\n");
  h.commit();
  assert.throws(h.check, /Generated output changed without advancing template version 2\.0\.1[\s\S]*preset minimal: M README\.md/);
  assert.equal(git(h.root, "status", "--porcelain"), "", "comparison leaves source untouched");
});

test("a feature outside every preset is still checked", (t) => {
  const h = history(t);
  h.write("demo.txt", "fixed feature\n");
  h.commit();
  assert.throws(h.check, /feature demo: M demo\.txt/);
});

test("an initializer-only change that changes generated content requires a release", (t) => {
  const h = history(t);
  h.write("template/init.mjs", readFileSync(join(h.root, "template/init.mjs"), "utf8").replace("(text) => text;", "(text) => text.toUpperCase();"));
  h.commit();
  assert.throws(h.check, /M README\.md/);
});

test("template-only edits with unchanged output do not require a release", (t) => {
  const h = history(t);
  h.write("template/README.md", "Maintainer instructions.\n");
  h.commit();
  assert.deepEqual(h.check(), { before: "2.0.1", after: "2.0.1", changed: [] });
});

test("a new preset name requires a release even when it generates an existing selection", (t) => {
  const h = history(t);
  h.manifest.presets.basic = [];
  h.save();
  h.commit();
  assert.throws(h.check, /template presets changed/);
});

test("version bumps use numeric ordering and a version cannot move backwards", (t) => {
  const h = history(t);
  h.manifest.version = "2.0.10";
  h.write("README.md", "changed\n");
  h.save();
  h.commit();
  assert.deepEqual(h.check(), { before: "2.0.1", after: "2.0.10", changed: [] });
  h.manifest.version = "2.0.0";
  h.save();
  h.commit();
  assert.throws(h.check, /goes backwards/);
});

test("unavailable refs and malformed versions fail instead of reporting unchanged output", (t) => {
  const h = history(t);
  assert.throws(() => checkRelease({ root: h.root, base: "missing", head: "HEAD" }), /Cannot resolve/);
  h.manifest.version = "latest";
  h.save();
  h.commit();
  assert.throws(h.check, /Invalid template version/);
});

test("advancing from an older base cannot reuse an already tagged version for different output", (t) => {
  const h = history(t);
  h.manifest.version = "2.1.0";
  h.save();
  h.commit();
  git(h.root, "tag", "v2.1.0");
  assert.equal(h.check().after, "2.1.0", "the tag at the candidate commit is valid");
  h.write("template/README.md", "Template-only follow-up.\n");
  h.commit();
  assert.equal(h.check().after, "2.1.0", "unchanged tagged output remains a valid baseline");
  h.write("README.md", "unreleased content\n");
  h.commit();
  assert.throws(h.check, /already tagged and cannot be reused/);
});

test("every verify event selects its actual base and head, without hiding missing PR refs", () => {
  const previous = "1".repeat(40);
  assert.deepEqual(eventRefs({ EVENT: "pull_request", PR_BASE: "base", PR_HEAD: "head", SHA: "merge" }), { base: "base", head: "head" });
  assert.deepEqual(eventRefs({ EVENT: "merge_group", QUEUE_BASE: "base", QUEUE_HEAD: "queue" }), { base: "base", head: "queue" });
  assert.deepEqual(eventRefs({ EVENT: "push", BEFORE: previous, SHA: "head" }), { base: previous, head: "head" });
  assert.deepEqual(eventRefs({ EVENT: "push", BEFORE: "0".repeat(40), SHA: "head" }), { base: "head^", head: "head" });
  assert.deepEqual(eventRefs({ EVENT: "workflow_dispatch", BEFORE: previous, SHA: "head" }), { base: "head^", head: "head" });
  assert.throws(() => eventRefs({ EVENT: "pull_request" }), /base and head are required/);
  assert.throws(() => eventRefs({ EVENT: "merge_group" }), /base and head are required/);
});
