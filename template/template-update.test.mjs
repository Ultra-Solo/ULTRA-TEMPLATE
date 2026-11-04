/**
 * template-update, commit-based (ADR-0041): the template has no releases and no tags, so a fixture is
 * two commits of a source repo — FROM, the commit a project was generated from, and TO, the newer one
 * the update moves it to — and a project is made by running init against the fixture at FROM.
 */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ROOT } from "./init.mjs";
import { PROVENANCE_FILE, readProvenance } from "../scripts/template-source.mjs";
import { UpdateError, checkForUpdate, compareVersions, readOrigin, recordUpdate, remoteIdentity, update } from "../scripts/template-update.mjs";

const NOTE = "a policy note the newer template commit adds";
const quiet = () => {};

const work = mkdtempSync(join(tmpdir(), "template-update-test-"));
// A source repo: the template's tracked files as one commit (FROM), then a change (TO).
const template = join(work, "template");
mkdirSync(template, { recursive: true });
for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean)) {
  const dest = join(template, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(ROOT, file), dest);
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git(template, "init", "-q");
git(template, "add", "-A");
git(template, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "FROM");
const FROM = git(template, "rev-parse", "HEAD").trim();
writeFileSync(join(template, "SECURITY.md"), `${readFileSync(join(template, "SECURITY.md"), "utf8")}\n## Note\n\n${NOTE}\n`);
git(template, "add", "-A");
git(template, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "TO");
const TO = git(template, "rev-parse", "HEAD").trim();

/** A project generated from the fixture template at `commit`, then committed as its own repo. */
function project(name, { commit: from = FROM, features } = {}) {
  const dir = join(work, name);
  const args = ["template/init.mjs", "--source", template, "--source-commit", from, "--name", "demo-app", "--owner", "octo-org", "--out", dir];
  if (features && features.length > 0) args.push("--features", features.join(","));
  else args.push("--preset", "minimal");
  execFileSync(process.execPath, args, { cwd: template, stdio: ["ignore", "pipe", "pipe"] });
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  commit(dir, "chore: generated project");
  return dir;
}
const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", message);
};
const run = (dir, options = {}) => update({ project: dir, to: TO, template, owner: "octo-org", repo: "demo-app", log: quiet, ...options });
const provenance = (dir) => readProvenance(dir);

test("a template commit's change reaches the project, and the project's own changes stay", () => {
  const dir = project("apply");
  const readme = join(dir, "README.md");
  writeFileSync(readme, `${readFileSync(readme, "utf8")}\nOur own section.\n`);
  commit(dir, "docs: ours");

  const result = run(dir);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.status, "applied");
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
  assert.match(readFileSync(readme, "utf8"), /Our own section\./);
  // Generated projects keep no CHANGELOG; the provenance record is the baseline (schema 2).
  assert.equal(existsSync(join(dir, "CHANGELOG.md")), false);
  assert.equal(provenance(dir).source.commit, TO);
  assert.doesNotMatch(readFileSync(join(dir, "SECURITY.md"), "utf8"), /hynix666\/ULTRA-TEMPLATE/);
});

test("the provenance record an update writes is the one init writes for the same commit", () => {
  const dir = project("same-record");
  run(dir);
  const fresh = project("fresh-from-to", { commit: TO });
  assert.equal(readFileSync(join(dir, PROVENANCE_FILE), "utf8"), readFileSync(join(fresh, PROVENANCE_FILE), "utf8"));
});

test("a change the project also made to the same file is a conflict left for a person", () => {
  const dir = project("conflict");
  const security = join(dir, "SECURITY.md");
  writeFileSync(security, `${readFileSync(security, "utf8")}\nOur policy.\n`);
  commit(dir, "docs: our policy");

  const result = run(dir);

  assert.deepEqual(result.conflicts, ["SECURITY.md"]);
  assert.match(readFileSync(security, "utf8"), /<<<<<<< /);
});

test("a dry run changes nothing, and an update already made is not made twice", () => {
  const dir = project("dry");

  const dry = run(dir, { dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.ok(dry.changed.some((line) => line.endsWith("SECURITY.md")), dry.changed.join());
  assert.equal(git(dir, "status", "--porcelain"), "");

  run(dir);
  commit(dir, "chore: update the template");
  assert.equal(run(dir).status, "current");
});

test("a change to a file the project deleted is skipped, not forced back", () => {
  const dir = project("deleted");
  git(dir, "rm", "-q", "SECURITY.md");
  commit(dir, "chore: our policy lives elsewhere");

  const result = run(dir);

  assert.deepEqual(result.skipped, ["SECURITY.md"]);
  assert.equal(existsSync(join(dir, "SECURITY.md")), false);
});

test("it refuses to go back to an earlier commit, and changes nothing", () => {
  const dir = project("downgrade", { commit: TO });
  const before = git(dir, "rev-parse", "HEAD");
  assert.throws(() => run(dir, { to: FROM }), /not a descendant/);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("a commit outside the template's future is named as such, and changes nothing", () => {
  const dir = project("no-such-commit");
  const before = git(dir, "rev-parse", "HEAD");
  const missing = "0".repeat(40);
  assert.throws(() => run(dir, { to: missing }), (err) => err instanceof UpdateError && new RegExp(`${missing.slice(0, 12)} is not a descendant`).test(err.message));
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("a template it cannot reach exits 2, could not run, never 1, which means conflicts", () => {
  const dir = project("unreachable");
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/template-update.mjs"), "--to", TO, "--template", join(work, "no-such-template"), "--owner", "octo-org", "--repo", "demo-app"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^template-update: /m);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("it refuses to start without what it needs", () => {
  const dir = project("refusals");
  assert.throws(() => run(dir, { to: "newest" }), /--to must be a full lowercase 40-character commit SHA, or latest/);
  writeFileSync(join(dir, "README.md"), "uncommitted\n");
  assert.throws(() => run(dir), /uncommitted changes/);
});

test("the legacy CHANGELOG origin line is still read, and recordUpdate names the commit, not a release", () => {
  const url = "https://github.com/Ultra-Solo/ULTRA-TEMPLATE";
  const changelog = [
    "## [Unreleased]",
    "",
    "- Updated to [ULTRA-TEMPLATE v1.4.0](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v1.4.0).",
    "- Initialized from [ULTRA-TEMPLATE v1.2.0](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v1.2.0) with go-service, release.",
  ].join("\n");
  // The newer line sits above the older one; the highest version wins, not the last line.
  const origin = readOrigin(changelog);
  assert.equal(origin.version, "v1.4.0");
  assert.deepEqual(origin.features, ["go-service", "release"]);
  assert.equal(compareVersions("v1.10.0", "v1.9.9") > 0, true, "numeric, not lexical");
  const sha = "a".repeat(40);
  assert.match(recordUpdate("## [Unreleased]\n", url, sha, ["web"]), new RegExp(`- Updated to \\[ULTRA-TEMPLATE ${sha.slice(0, 12)}\\]\\(${url}/tree/${sha}\\) with web\\.`));
  assert.match(recordUpdate("## [Unreleased]\n", url, sha, []), / with no features\./);
  assert.doesNotMatch(recordUpdate("## [Unreleased]\n", url, sha), / with /);
  assert.deepEqual(remoteIdentity("git@github.com:octo-org/demo-app.git"), { owner: "octo-org", repo: "demo-app" });
  assert.equal(remoteIdentity("https://gitlab.com/octo-org/demo-app"), null);
});

/** A project made from FROM with `features`, and the template left at its newest commit TO. */
function withFeatures(name, features) {
  return project(name, { features });
}
const select = (dir, options) => update({ project: dir, template, owner: "octo-org", repo: "demo-app", log: quiet, ...options });
const workflow = (dir) => readFileSync(join(dir, ".github/workflows/verify.yml"), "utf8");

test("removing a feature takes its files and its marked lines out, and records the new selection", () => {
  const dir = withFeatures("remove", ["ts-library", "release"]);
  assert.match(workflow(dir), /^ {2}ts-library:$/m);

  const result = select(dir, { remove: ["ts-library"] });

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.features, ["release"]);
  assert.equal(existsSync(join(dir, "packages/ts-library")), false);
  assert.doesNotMatch(workflow(dir), /ts-library/);
  assert.doesNotMatch(readFileSync(join(dir, ".github/dependabot.yml"), "utf8"), /ts-library/);
  // Still on the commit it was on; only the selection moved.
  const record = provenance(dir);
  assert.equal(record.source.commit, FROM);
  assert.deepEqual(record.inputs.features, ["release"]);
});

test("removing a feature removes its directory whole, installed dependencies included", () => {
  const dir = withFeatures("remove-installed", ["ts-library"]);
  // What setup leaves in a module: ignored, so the working tree is still clean.
  mkdirSync(join(dir, "packages/ts-library/node_modules/pkg"), { recursive: true });
  writeFileSync(join(dir, "packages/ts-library/node_modules/pkg/index.js"), "");
  assert.equal(git(dir, "status", "--porcelain"), "");

  select(dir, { remove: ["ts-library"] });

  // A module is present when its directory is; one left holding only node_modules is still "present".
  assert.equal(existsSync(join(dir, "packages/ts-library")), false);
});

test("adding a feature brings its files and marked lines in, in the template's order", () => {
  const dir = withFeatures("add", ["release"]);
  const result = select(dir, { add: ["ts-library"] });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.features, ["ts-library", "release"]);
  assert.equal(existsSync(join(dir, "packages/ts-library/package.json")), true);
  assert.match(workflow(dir), /^ {2}ts-library:$/m);
  assert.deepEqual(provenance(dir).inputs.features, ["ts-library", "release"]);
});

test("a selection change and a commit move are one update", () => {
  const dir = withFeatures("both", []);
  const result = select(dir, { to: TO, add: ["release"] });
  assert.deepEqual(result.conflicts, []);
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
  assert.equal(existsSync(join(dir, ".github/workflows/release.yml")), true);
  const record = provenance(dir);
  assert.equal(record.source.commit, TO);
  assert.deepEqual(record.inputs.features, ["knowledge", "release"]);
});

test("a dry run of a selection change lists the files and writes nothing", () => {
  const dir = withFeatures("dry-select", ["release"]);
  const result = select(dir, { add: ["ts-library"], dryRun: true });
  assert.equal(result.status, "dry-run");
  assert.ok(result.changed.some((line) => line === "A packages/ts-library/package.json"), result.changed.join());
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("an impossible selection is refused before anything is written", () => {
  const dir = withFeatures("refuse-select", ["release"]);
  const head = git(dir, "rev-parse", "HEAD");
  assert.throws(() => select(dir, { add: ["release"] }), /release is already one of this project's features/);
  assert.throws(() => select(dir, { remove: ["web"] }), /web is not one of this project's features: release/);
  assert.throws(() => select(dir, { add: ["kubernetes"] }), /defines no feature kubernetes\. It defines: /);
  assert.throws(() => select(dir, {}), /Nothing to do/);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
});

test("removing a feature whose files the project changed or added to is refused, by path", () => {
  const dir = withFeatures("refuse-edited", ["ts-library", "release"]);
  const readme = join(dir, "packages/ts-library/README.md");
  writeFileSync(readme, `${readFileSync(readme, "utf8")}\nOur notes.\n`);
  writeFileSync(join(dir, "packages/ts-library/src/extra.ts"), "export const extra = 1;\n");
  git(dir, "add", "-A");
  commit(dir, "feat: our own library work");
  const head = git(dir, "rev-parse", "HEAD");

  assert.throws(
    () => select(dir, { remove: ["ts-library"] }),
    (err) =>
      err instanceof UpdateError &&
      /packages\/ts-library\/README\.md \(this project changed it, and the update deletes it\)/.test(err.message) &&
      /packages\/ts-library\/src\/extra\.ts \(this project's own file, inside a feature being removed\)/.test(err.message),
  );
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
});

test("recorded identity reconstructs a project after package.json is removed", () => {
  const dir = project("unnamed");
  rmSync(join(dir, "package.json"));
  commit(dir, "chore: no root package.json");
  assert.equal(run(dir).status, "applied");
});

test("each commit is printed before its init runs, since that init is code this runs", () => {
  const dir = project("logged");
  const lines = [];
  run(dir, { log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes(`template-update: ${FROM.slice(0, 12)} → ${TO.slice(0, 12)}`)), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes(`commit ${TO.slice(0, 12)} resolved`)), lines.join("\n"));
});

test("run from a subdirectory, it updates the whole project", () => {
  const dir = project("from-below");
  const below = join(dir, "docs");
  const result = spawnSync(process.execPath, [join(dir, "scripts/template-update.mjs"), "--to", TO, "--template", template, "--owner", "octo-org", "--repo", "demo-app"], { cwd: below, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
});

test("--check reports a newer commit and the command that takes it, without touching the tree", () => {
  const dir = project("check-behind");
  writeFileSync(join(dir, "README.md"), `${readFileSync(join(dir, "README.md"), "utf8")}\nUncommitted.\n`);

  const report = checkForUpdate({ project: dir, template });

  assert.equal(report.schema, 2);
  assert.deepEqual(report.current, { commit: FROM, source: "provenance" });
  assert.deepEqual(report.latest, { commit: TO });
  assert.equal(report.updateAvailable, true);
  assert.equal(report.command, `node scripts/template-update.mjs --to ${TO}`);
  assert.equal(git(dir, "status", "--porcelain").trim(), "M README.md");
});

test("--check on the newest commit says so", () => {
  const dir = project("check-current", { commit: TO });

  const report = checkForUpdate({ project: dir, template });

  assert.deepEqual(report.current, { commit: TO, source: "provenance" });
  assert.equal(report.updateAvailable, false);
});

test("--check reads CHANGELOG.md when a legacy project predates the provenance record", () => {
  const dir = project("check-legacy");
  rmSync(join(dir, PROVENANCE_FILE));
  writeFileSync(join(dir, "CHANGELOG.md"), `## [Unreleased]\n\n- Initialized from [ULTRA-TEMPLATE v3.0.0](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v3.0.0) with no features.\n`);
  commit(dir, "chore: a project from before provenance");

  const report = checkForUpdate({ project: dir, template });

  assert.deepEqual(report.current, { version: "v3.0.0", source: "changelog" });
  assert.equal(report.updateAvailable, true);
});

test("--check refuses a provenance record it cannot read, and names a project that records nothing", () => {
  const unreadable = project("check-bad-provenance");
  writeFileSync(join(unreadable, PROVENANCE_FILE), "{ not json\n");
  assert.throws(
    () => checkForUpdate({ project: unreadable, template }),
    (err) => err instanceof UpdateError && /not valid JSON/.test(err.message),
  );

  const silent = project("check-nothing");
  rmSync(join(silent, PROVENANCE_FILE));
  assert.throws(() => checkForUpdate({ project: silent, template }), /CHANGELOG.md is missing/);
});

test("--check on a template it cannot reach is an error, never a silent no", () => {
  const dir = project("check-unreachable");
  assert.throws(
    () => checkForUpdate({ project: dir, template: join(work, "no-such-template") }),
    (err) => err instanceof UpdateError && /cannot resolve the HEAD of/.test(err.message),
  );
});

test("--check exits 1 when a newer commit is out and 0 at the newest, and takes no update option", () => {
  const dir = project("check-main");
  const check = () =>
    spawnSync(process.execPath, [join(dir, "scripts/template-update.mjs"), "--check", "--template", template], {
      cwd: dir,
      encoding: "utf8",
    });

  const behind = check();
  assert.equal(behind.status, 1, behind.stderr);
  assert.equal(JSON.parse(behind.stdout).updateAvailable, true);

  const mixed = spawnSync(process.execPath, [join(dir, "scripts/template-update.mjs"), "--check", "--to", TO, "--template", template], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /--check only takes --template/);

  run(dir);
  const current = check();
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).updateAvailable, false);
});

test("a file the newer commit adds that the project already has, byte for byte, is not in the way; --to latest takes the newest commit", () => {
  const dir = project("already-has-it");
  // A later commit that adds a file, which this project happened to add itself, identically.
  const added = "## Support\n\nAsk in the discussions.\n";
  writeFileSync(join(template, "SUPPORT.md"), added);
  git(template, "add", "-A");
  git(template, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "a commit that adds a file");
  const LATEST = git(template, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "SUPPORT.md"), added);
  git(dir, "add", "-A");
  commit(dir, "docs: support");

  const result = run(dir, { to: "latest" });

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.to, LATEST);
  assert.ok(!result.changed.some((line) => line.endsWith(" SUPPORT.md")), `SUPPORT.md is not a change: ${result.changed.join(", ")}`);
  assert.equal(provenance(dir).source.commit, LATEST);
  // Restore the fixture: other tests expect TO as HEAD.
  git(template, "reset", "-q", "--hard", TO);
});
