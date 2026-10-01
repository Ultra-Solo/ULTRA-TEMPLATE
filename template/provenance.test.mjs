import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadManifest, main, plan, ROOT, validateDescription } from "./init.mjs";
import { update } from "../scripts/template-update.mjs";
import { generateSource, readProvenance, resolveSource, validateProvenance, writeProvenance } from "../scripts/template-source.mjs";
import { diffTrees } from "./release-notes.mjs";
import { checkRelease } from "./check-release.mjs";
import { sourceFixture } from "./test-source.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const save = (root) => {
  git(root, "add", "-A");
  git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
};

test("descriptions reject both HTML comment end delimiters in CLI and saved provenance", () => {
  const record = { schemaVersion: 1,
    source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE", version: "v3.0.0", tag: "v3.0.0", commit: "1".repeat(40) },
    inputs: { identity: { name: "demo-app", owner: "octo", repo: "demo-app" }, features: [], year: 2026,
      description: { sentence: "A description.", generated: false } },
  };
  for (const end of ["-->", "--!>"]) {
    const sentence = `Description ${end} trailing text`;
    assert.throws(() => validateDescription(sentence), /no HTML comment/);
    assert.throws(() => validateProvenance({ ...record, inputs: { ...record.inputs, description: { sentence, generated: false } } }), /malformed/);
  }
});

test("a moved baseline tag is rejected even for an already-current update, before source execution", (t) => {
  const work = mkdtempSync(join(tmpdir(), "provenance-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, "source");
  for (const file of git(ROOT, "ls-files", "-z").split("\0").filter(Boolean)) {
    if (!existsSync(join(ROOT, file))) continue;
    mkdirSync(dirname(join(source, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(source, file));
  }
  git(source, "init", "-q");
  const commit = save(source);
  const manifest = loadManifest(source);
  const tag = `v${manifest.version}`;
  git(source, "tag", tag);
  const project = join(work, "project");
  const identity = { name: "demo-app", owner: "octo", repo: "demo-app" };
  const description = { sentence: "No application code yet: the checks, CI and agent instructions are in place for the first module.", generated: true };
  for (const { file, data } of plan(source, manifest, new Set(), identity, description, 2031).files) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), data);
  }
  writeFileSync(join(project, ".template-provenance.json"), JSON.stringify({
    schemaVersion: 1,
    source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE", version: tag, tag, commit },
    inputs: { identity, features: [], description, year: 2031 },
  }));
  git(project, "init", "-q");
  save(project);
  const sentinel = join(work, "unexpected-source-ran");
  const init = join(source, "template/init.mjs");
  writeFileSync(init, `${readFileSync(init, "utf8")}\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\n`);
  save(source);
  git(source, "tag", "--force", tag);
  assert.throws(() => update({ project, to: tag, template: source, log: () => {} }), /tag.*(moved|commit|match)/i);
  assert.equal(existsSync(sentinel), false);
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("a template copy generates the released source, not its independently committed main output", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  const copy = sourceFixture(ROOT, loadManifest().version);
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); });
  const tag = `v${loadManifest().version}`;
  const original = git(source, "rev-parse", tag);
  for (const root of [source, copy]) {
    writeFileSync(join(root, "SECURITY.md"), `${readFileSync(join(root, "SECURITY.md"), "utf8")}\nUnreleased main drift.\n`);
    save(root);
  }
  const out = join(copy, "output");
  execFileSync(process.execPath, ["template/init.mjs", "--source", source, "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--out", out], { cwd: copy });
  const record = readProvenance(out);
  assert.equal(record.source.commit, original);
  assert.notEqual(record.source.commit, git(copy, "rev-parse", "HEAD"));
  assert.doesNotMatch(readFileSync(join(out, "SECURITY.md"), "utf8"), /Unreleased main drift/);
});

test("every preset's recorded inputs reconstruct its generated bytes, including description and future copyright year", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  const work = mkdtempSync(join(tmpdir(), "reconstruct-"));
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const snapshot = resolveSource(source, { version: `v${loadManifest().version}` });
  for (const [preset, features] of Object.entries(snapshot.manifest.presets)) {
    const out = join(work, preset);
    execFileSync(process.execPath, [join(ROOT, "template/init.mjs"), "--source", source, "--preset", preset, "--name", "demo-app", "--owner", "octo", "--description", "Our original project description.", "--out", out]);
    const record = readProvenance(out);
    assert.deepEqual(record.inputs.features, features);
    assert.equal(record.source.commit, snapshot.source.commit);
    const reconstructed = `${out}-again`;
    generateSource(source, snapshot, record.inputs, reconstructed);
    assert.deepEqual(diffTrees(out, reconstructed), [], preset);
    const future = { ...record.inputs, year: 2031 };
    const later = `${out}-future`;
    generateSource(source, snapshot, future, later);
    assert.match(readFileSync(join(later, "LICENSE"), "utf8"), /^Copyright \(c\) 2031 octo$/m);
  }
});

test("failed publication and unavailable explicit commits leave destinations untouched", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "unavailable-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const out = join(work, "never-written");
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  const args = ["--name", "demo-app", "--owner", "octo", "--preset", "minimal", "--out", out];
  await assert.rejects(main(args), /not a verified published release/);
  assert.equal(existsSync(out), false);
  const source = sourceFixture(ROOT, loadManifest().version);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["template/init.mjs", "--source", source, "--source-commit", "0".repeat(40), ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /No initializer ran/);
  assert.equal(existsSync(out), false);
});

test("unreleased local generation records a commit without a published-release claim", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  const work = mkdtempSync(join(tmpdir(), "offline-"));
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const sha = git(source, "rev-parse", "HEAD");
  const out = join(work, "project");
  execFileSync(process.execPath, ["template/init.mjs", "--source", source, "--source-commit", sha, "--preset", "minimal", "--name", "demo-app", "--owner", "octo", "--out", out], { cwd: ROOT });
  assert.equal(readProvenance(out).source.tag, null);
  assert.match(readFileSync(join(out, "CHANGELOG.md"), "utf8"), new RegExp(`Initialized from .* source\\]\\(https://github.com/Ultra-Solo/ULTRA-TEMPLATE/tree/${sha}\\)`));
  git(out, "init", "-q"); save(out);
  update({ project: out, add: ["devcontainer"], template: source, log: () => {} });
  assert.equal(readProvenance(out).source.tag, null);
  assert.deepEqual(readProvenance(out).inputs.features, ["devcontainer"]);
});

test("updates retain original inputs after package and repository renames", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  const work = mkdtempSync(join(tmpdir(), "renamed-"));
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const snapshot = resolveSource(source, { version: `v${loadManifest().version}` });
  const inputs = { identity: { name: "demo-app", owner: "octo", repo: "demo-app" }, features: [], year: 2031,
    description: { generated: false, sentence: "The original description survives." } };
  const project = join(work, "project");
  generateSource(source, snapshot, inputs, project);
  writeProvenance(project, { schemaVersion: 1, source: snapshot.source, inputs });
  git(project, "init", "-q"); save(project);
  const pkg = join(project, "package.json");
  const data = JSON.parse(readFileSync(pkg, "utf8")); data.name = "renamed-app";
  writeFileSync(pkg, `${JSON.stringify(data, null, 2)}\n`);
  git(project, "remote", "add", "origin", "https://github.com/other-org/Other.Repo.git");
  save(project);
  const manifest = loadManifest(source); const to = `v${Number(manifest.version.split(".")[0]) + 1}.0.0`;
  manifest.version = to.slice(1);
  writeFileSync(join(source, "template/features.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(source, "SECURITY.md"), `${readFileSync(join(source, "SECURITY.md"), "utf8")}\nA vendor fix.\n`);
  const next = save(source); git(source, "tag", to);
  const result = update({ project, to, template: source, log: () => {} });
  assert.deepEqual(result.conflicts, []);
  const record = readProvenance(project);
  assert.deepEqual(record.inputs, inputs);
  assert.equal(record.source.commit, next);
  assert.equal(JSON.parse(readFileSync(pkg, "utf8")).name, "renamed-app");
  assert.match(readFileSync(join(project, "README.md"), "utf8"), /The original description survives/);
  assert.match(readFileSync(join(project, "LICENSE"), "utf8"), /^Copyright \(c\) 2031 octo$/m);
});

test("legacy migration requires a reviewed baseline and malformed records fail closed", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  const work = mkdtempSync(join(tmpdir(), "legacy-"));
  t.after(() => { rmSync(source, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const snapshot = resolveSource(source, { version: `v${loadManifest().version}` });
  const inputs = { identity: { name: "demo-app", owner: "octo", repo: "demo-app" }, features: [], year: 2026,
    description: { generated: true, sentence: "No application code yet: the checks, CI and agent instructions are in place for the first module." } };
  const project = join(work, "project");
  generateSource(source, snapshot, inputs, project);
  git(project, "init", "-q"); save(project);
  const options = { project, to: snapshot.source.version, template: source, owner: "octo", repo: "demo-app", log: () => {} };
  assert.throws(() => update(options), /Legacy project/);
  assert.equal(git(project, "status", "--porcelain"), "");
  assert.throws(() => update({ ...options, legacyCommit: "1".repeat(40) }), /tag moved/);
  update({ ...options, legacyCommit: snapshot.source.commit });
  assert.equal(readProvenance(project).source.commit, snapshot.source.commit);
  save(project);
  assert.throws(() => update({ ...options, toCommit: "0".repeat(40) }), /tag moved/);
  assert.equal(git(project, "status", "--porcelain"), "");
  writeFileSync(join(project, ".template-provenance.json"), '{"schemaVersion": 2}'); save(project);
  assert.throws(() => update(options), /unsupported schema/);
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("template-only commits do not force a release because their provenance SHA changes", (t) => {
  const source = sourceFixture(ROOT, loadManifest().version);
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const base = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "template/README.md"), `${readFileSync(join(source, "template/README.md"), "utf8")}\nMaintainer note.\n`);
  const head = save(source);
  assert.equal(checkRelease({ root: source, base, head }).after, loadManifest().version);
});
