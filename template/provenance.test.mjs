/**
 * Tests for the exact-source and reconstruction guarantees the initializer records (ADR-0041).
 *
 * The template has no releases and no versions: a source is addressed by one full commit SHA, recorded
 * in .template-provenance.json as provenance schema 2, and "latest" means the upstream default branch's
 * HEAD. Legacy schema-1 records (which named a release) stay readable so an old project can be migrated
 * with a reviewed --legacy-commit baseline. Every test here works from local git fixtures, never the
 * network.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, validateDescription } from "./init.mjs";
import { checkForUpdate, update } from "../scripts/template-update.mjs";
import { PROVENANCE_FILE, generateSource, readProvenance, resolveSource, validateProvenance, writeProvenance } from "../scripts/template-source.mjs";
import { sourceFixture } from "./test-source.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const save = (root, message = "fixture commit") => {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", message]);
  return head(root);
};
const head = (root) => git(root, ["rev-parse", "HEAD"]).trim();

/** Every file of a directory, relative path to bytes, excluding git metadata and the provenance record. */
function tree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (rel !== PROVENANCE_FILE) out[rel] = readFileSync(join(dir, entry.name));
    }
  };
  walk(root, "");
  return out;
}
const diffTrees = (a, b) => {
  const ta = tree(a);
  const tb = tree(b);
  return [...new Set([...Object.keys(ta), ...Object.keys(tb)])].filter((k) => !ta[k]?.equals(tb[k]));
};

const identity = { name: "demo-app", owner: "octo", repo: "demo-app" };
const inputs = (features = []) => ({ identity, features, year: 2026, description: { generated: true, sentence: "A generated description." } });
const record2 = (commit) => ({ schemaVersion: 2, source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE", commit }, inputs: inputs() });

test("descriptions reject comment end delimiters in the CLI and in the saved provenance record", (t) => {
  const work = mkdtempSync(join(tmpdir(), "provenance-desc-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const out = join(work, "project");
  const result = spawnSync(process.execPath, [join(ROOT, "template/init.mjs"), "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--description", "A --> B", "--out", out], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /comment end delimiter/);
  assert.equal(existsSync(out), false);
  assert.throws(() => validateDescription({ generated: false, sentence: "A --> B" }), /comment end delimiter/);
  assert.throws(() => validateProvenance({ ...record2("1".repeat(40)), inputs: { ...inputs(), description: { generated: false, sentence: "A --> B" } } }), /comment end delimiter/);
});

test("schema 2 records carry a commit and reject any release claim; schema 1 stays readable", () => {
  const commit = "1".repeat(40);
  assert.equal(validateProvenance(record2(commit)), record2(commit));
  assert.throws(() => validateProvenance({ ...record2(commit), source: { ...record2(commit).source, version: "v3.0.0" } }), /malformed or has an unsupported schema/);
  assert.throws(() => validateProvenance({ ...record2(commit), source: { ...record2(commit).source, tag: "v3.0.0" } }), /malformed or has an unsupported schema/);
  assert.throws(() => validateProvenance({ schemaVersion: 2, source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE" } }), /malformed or has an unsupported schema/);
  const legacy = { schemaVersion: 1, source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE", version: "v3.0.0", tag: "v3.0.0", commit }, inputs: inputs() };
  assert.equal(validateProvenance(legacy), legacy);
  assert.throws(() => validateProvenance({ ...legacy, source: { ...legacy.source, tag: "v3.0.1" } }), /malformed or has an unsupported schema/);
});

test("a template copy generates the verified source commit, not its independently committed HEAD", (t) => {
  const source = sourceFixture(ROOT);
  const copy = sourceFixture(ROOT);
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); });
  const original = head(source);
  for (const root of [source, copy]) {
    writeFileSync(join(root, "SECURITY.md"), `${readFileSync(join(root, "SECURITY.md"), "utf8")}\nUnreleased HEAD drift.\n`);
    save(root);
  }
  const out = join(copy, "output");
  execFileSync(process.execPath, [join(copy, "template/init.mjs"), "--source", source, "--source-commit", original, "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--out", out], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] });
  const record = readProvenance(out);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.source.commit, original);
  assert.notEqual(record.source.commit, head(copy));
  assert.doesNotMatch(readFileSync(join(out, "SECURITY.md"), "utf8"), /Unreleased HEAD drift/);
});

test("every preset's recorded inputs reconstruct its generated bytes", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-presets-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const snapshot = resolveSource(source, { commit: sha });
  for (const [preset, features] of Object.entries(snapshot.manifest.presets)) {
    const out = join(work, preset);
    execFileSync(process.execPath, [join(ROOT, "template/init.mjs"), "--source", source, "--source-commit", sha, "--preset", preset, "--name", "demo-app", "--owner", "octo", "--description", "Our original project description.", "--out", out], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const record = readProvenance(out);
    assert.deepEqual(record.inputs.features, features, preset);
    assert.equal(record.source.commit, sha, preset);
    const reconstructed = `${out}-again`;
    generateSource(source, snapshot, record.inputs, reconstructed);
    assert.deepEqual(diffTrees(out, reconstructed), [], preset);
    // A recorded future copyright year still renders, because the year is part of the recorded inputs.
    const later = `${out}-future`;
    generateSource(source, snapshot, { ...record.inputs, year: 2031 }, later);
    assert.match(readFileSync(join(later, "LICENSE"), "utf8"), /^Copyright \(c\) 2031 octo$/m, preset);
  }
});

test("an explicit commit that does not exist in the source leaves the destination untouched", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-missing-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const out = join(work, "never-written");
  const result = spawnSync(process.execPath, [join(ROOT, "template/init.mjs"), "--source", source, "--source-commit", "0".repeat(40), "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--out", out], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /No initializer ran/);
  assert.equal(existsSync(out), false);
});

test("local generation records the commit and no release, and creates no CHANGELOG", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-local-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const out = join(work, "project");
  execFileSync(process.execPath, [join(ROOT, "template/init.mjs"), "--source", source, "--source-commit", sha, "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--out", out], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const record = readProvenance(out);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.source.commit, sha);
  assert.equal(record.source.version, undefined);
  assert.equal(record.source.tag, undefined);
  assert.equal(existsSync(join(out, "CHANGELOG.md")), false);
  git(out, ["init", "-q"]);
  save(out);
  update({ project: out, add: ["devcontainer"], template: source, log: () => {} });
  const after = readProvenance(out);
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.source.commit, sha);
  assert.deepEqual(after.inputs.features, ["knowledge", "devcontainer"]);
  assert.equal(existsSync(join(out, "CHANGELOG.md")), false);
});

test("updates retain original inputs after package and repository renames", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-update-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const snapshot = resolveSource(source, { commit: sha });
  const originalInputs = { identity, features: [], year: 2031, description: { generated: false, sentence: "The original description survives." } };
  const project = join(work, "project");
  generateSource(source, snapshot, originalInputs, project);
  writeProvenance(project, { schemaVersion: 2, source: snapshot.source, inputs: originalInputs });
  git(project, ["init", "-q"]);
  save(project);
  // The adopter renames the package and the repository after generation.
  const pkg = join(project, "package.json");
  writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg, "utf8")), name: "renamed-app" }, null, 2));
  git(project, ["remote", "add", "origin", "https://github.com/other-org/Other.Repo.git"]);
  save(project, "adopter renames");
  // The template moves forward with one commit.
  writeFileSync(join(source, "SECURITY.md"), `${readFileSync(join(source, "SECURITY.md"), "utf8")}\nUnreleased template fix.\n`);
  const next = save(source, "template fix");
  const result = update({ project, to: next, template: source, log: () => {} });
  assert.deepEqual(result.conflicts, []);
  const record = readProvenance(project);
  assert.deepEqual(record.inputs, originalInputs);
  assert.equal(record.source.commit, next);
  assert.equal(JSON.parse(readFileSync(pkg, "utf8")).name, "renamed-app");
  assert.match(readFileSync(join(project, "README.md"), "utf8"), /The original description survives/);
  assert.match(readFileSync(join(project, "LICENSE"), "utf8"), /^Copyright \(c\) 2031 octo$/m);
  assert.match(readFileSync(join(project, "SECURITY.md"), "utf8"), /Unreleased template fix/);
});

test("an update to a commit that is not a descendant is refused before anything runs", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-backward-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const first = head(source);
  writeFileSync(join(source, "SECURITY.md"), `${readFileSync(join(source, "SECURITY.md"), "utf8")}\nUnreleased template fix.\n`);
  const second = save(source, "template fix");
  const snapshot = resolveSource(source, { commit: second });
  const project = join(work, "project");
  generateSource(source, snapshot, inputs(), project);
  writeProvenance(project, { schemaVersion: 2, source: snapshot.source, inputs: inputs() });
  git(project, ["init", "-q"]);
  save(project);
  assert.throws(() => update({ project, to: first, template: source, log: () => {} }), /not a descendant/);
  assert.equal(git(project, ["status", "--porcelain"]).trim(), "");
  assert.equal(readProvenance(project).source.commit, second);
});

test("legacy projects without a provenance record need a reviewed --legacy-commit baseline", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-legacy-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const snapshot = resolveSource(source, { commit: sha });
  const project = join(work, "project");
  generateSource(source, snapshot, inputs(), project);
  // A schema-1 project records a release in its CHANGELOG instead of a provenance file.
  writeFileSync(join(project, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- Initialized from [ULTRA-TEMPLATE v3.0.0](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v3.0.0) with no features.\n");
  git(project, ["init", "-q"]);
  save(project);
  writeFileSync(join(source, "SECURITY.md"), `${readFileSync(join(source, "SECURITY.md"), "utf8")}\nUnreleased template fix.\n`);
  const next = save(source, "template fix");
  const options = { project, to: next, template: source, log: () => {} };
  assert.throws(() => update(options), /Legacy project/);
  assert.equal(git(project, ["status", "--porcelain"]).trim(), "");
  assert.throws(() => update({ ...options, legacyCommit: "1".repeat(40) }), /no source commit|not a descendant/);
  assert.equal(git(project, ["status", "--porcelain"]).trim(), "");
  update({ ...options, legacyCommit: sha });
  const record = readProvenance(project);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.source.commit, next);
  assert.match(readFileSync(join(project, "CHANGELOG.md"), "utf8"), new RegExp(`Updated to \\[ULTRA-TEMPLATE ${next.slice(0, 12)}\\]`));
});

test("malformed provenance fails closed and leaves the tree alone", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-malformed-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const snapshot = resolveSource(source, { commit: sha });
  const project = join(work, "project");
  generateSource(source, snapshot, inputs(), project);
  writeProvenance(project, { schemaVersion: 2, source: snapshot.source, inputs: inputs() });
  git(project, ["init", "-q"]);
  save(project);
  writeFileSync(join(project, PROVENANCE_FILE), JSON.stringify({ schemaVersion: 2 }));
  save(project, "corrupt the record");
  assert.throws(() => update({ project, to: sha, template: source, log: () => {} }), /malformed or has an unsupported schema/);
  assert.throws(() => checkForUpdate({ project, template: source }), /malformed or has an unsupported schema/);
  assert.equal(readFileSync(join(project, PROVENANCE_FILE), "utf8"), JSON.stringify({ schemaVersion: 2 }));
});

test("--check reports the recorded commit against the upstream HEAD as JSON", (t) => {
  const source = sourceFixture(ROOT);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), "provenance-check-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sha = head(source);
  const snapshot = resolveSource(source, { commit: sha });
  const project = join(work, "project");
  generateSource(source, snapshot, inputs(), project);
  writeProvenance(project, { schemaVersion: 2, source: snapshot.source, inputs: inputs() });
  git(project, ["init", "-q"]);
  save(project);
  const report = checkForUpdate({ project, template: source });
  assert.equal(report.schema, 2);
  assert.deepEqual(report.current, { commit: sha, source: "provenance" });
  assert.equal(report.latest.commit, sha);
  assert.equal(report.updateAvailable, false);
  assert.match(report.command, new RegExp(`--to ${sha}`));
  writeFileSync(join(source, "SECURITY.md"), `${readFileSync(join(source, "SECURITY.md"), "utf8")}\nUnreleased template fix.\n`);
  const next = save(source, "template fix");
  const newer = checkForUpdate({ project, template: source });
  assert.equal(newer.latest.commit, next);
  assert.equal(newer.updateAvailable, true);
  assert.match(newer.command, new RegExp(`--to ${next}`));
});
