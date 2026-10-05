// scripts/template-update.mjs, run against a real release history: this tree as one release, the
// same tree with a change as the next, and a project generated from the first. Template-only, because
// generating needs the template, which init deletes from every project.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import {
  checkForUpdate,
  compareVersions,
  readOrigin,
  recordUpdate,
  remoteIdentity,
  update,
  UpdateError,
} from "../scripts/template-update.mjs";
import { PROVENANCE_FILE } from "../scripts/template-source.mjs";
import { loadManifest, ROOT } from "./init.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (cwd, message) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-am", message);
const quiet = () => {};

const { version } = loadManifest();
const FROM = `v${version}`;
const [major, minor] = version.split(".").map(Number);
const TO = `v${major}.${minor + 1}.0`;
const NOTE = "Security fixes are released for the latest minor version only.";

let work;
let template;

before(() => {
  work = mkdtempSync(join(tmpdir(), "tu-"));
  template = join(work, "template");
  for (const file of git(ROOT, "ls-files", "-z").split("\0").filter(Boolean)) {
    if (!existsSync(join(ROOT, file))) continue;
    mkdirSync(dirname(join(template, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(template, file));
  }
  git(template, "init", "-q");
  git(template, "config", "core.autocrlf", "false");
  git(template, "add", "-A");
  commit(template, "release");
  git(template, "tag", FROM);
  // The next release changes one chassis file and bumps the version, as a real release does.
  const security = join(template, "SECURITY.md");
  writeFileSync(security, readFileSync(security, "utf8").replace("## Reporting a vulnerability", `${NOTE}\n\n## Reporting a vulnerability`));
  const manifest = join(template, "template/features.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"version": "${version}"`, `"version": "${TO.slice(1)}"`));
  commit(template, "next release");
  git(template, "tag", TO);
});

after(() => rmSync(work, { recursive: true, force: true }));

/** A project made from the first release, committed, as a team would have it. */
function project(name, features = []) {
  const dir = join(work, name);
  const selection = features.length === 0 ? ["--preset", "minimal"] : ["--features", features.join(",")];
  execFileSync(process.execPath, ["template/init.mjs", "--source", template, "--name", "demo-app", "--owner", "octo-org", ...selection, "--out", dir], {
    cwd: join(work, "template"),
    stdio: "ignore",
  });
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  commit(dir, "chore: initialize project");
  return dir;
}

const run = (dir, options = {}) => update({ project: dir, to: TO, template, owner: "octo-org", repo: "demo-app", log: quiet, ...options });

test("a template change reaches the project, and the project's own changes stay", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("clean");
  git(template, "checkout", "-q", "-");
  const readme = join(dir, "README.md");
  writeFileSync(readme, `${readFileSync(readme, "utf8")}\nOur own section.\n`);
  commit(dir, "docs: our section");

  const result = run(dir);

  assert.deepEqual(result.conflicts, []);
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
  assert.match(readFileSync(readme, "utf8"), /Our own section\./);
  // Renamed as the project is named, never as the template: the identity came through init.
  assert.doesNotMatch(readFileSync(join(dir, "SECURITY.md"), "utf8"), /hynix666\/ULTRA-TEMPLATE/);
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`Updated to \\[ULTRA-TEMPLATE ${TO.replaceAll(".", "\\.")}\\]`));
  assert.equal(readOrigin(changelog).version, TO, "the next update starts from here");
});

test("where the project changed the same lines, the conflict is left to resolve", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("conflict");
  git(template, "checkout", "-q", "-");
  const security = join(dir, "SECURITY.md");
  writeFileSync(security, readFileSync(security, "utf8").replace("## Reporting a vulnerability", "Our own policy line.\n\n## Reporting a vulnerability"));
  commit(dir, "docs: our policy");

  const result = run(dir);

  assert.deepEqual(result.conflicts, ["SECURITY.md"]);
  assert.match(readFileSync(security, "utf8"), /<<<<<<< /);
});

test("a dry run changes nothing, and an update already made is not made twice", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("dry");
  git(template, "checkout", "-q", "-");

  const dry = run(dir, { dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.ok(dry.changed.some((line) => line.endsWith("SECURITY.md")), dry.changed.join());
  assert.equal(git(dir, "status", "--porcelain"), "");

  run(dir);
  commit(dir, "chore: update the template");
  assert.equal(run(dir).status, "current");
});

test("a change to a file the project deleted is skipped, not forced back", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("deleted");
  git(template, "checkout", "-q", "-");
  git(dir, "rm", "-q", "SECURITY.md");
  commit(dir, "chore: our policy lives elsewhere");

  const result = run(dir);

  assert.deepEqual(result.skipped, ["SECURITY.md"]);
  assert.equal(existsSync(join(dir, "SECURITY.md")), false);
});

test("it refuses to go back to an older release, and changes nothing", () => {
  const dir = project("downgrade");
  const before = git(dir, "rev-parse", "HEAD");
  assert.throws(() => run(dir, { to: FROM }), /older than/);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("a release that does not exist is named as such, and changes nothing", () => {
  const dir = project("no-such-release");
  const before = git(dir, "rev-parse", "HEAD");
  assert.throws(() => run(dir, { to: "v9.9.9" }), (err) => err instanceof UpdateError && /no release v9\.9\.9/.test(err.message));
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("a template it cannot reach exits 2, could not run, never 1, which means conflicts", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("unreachable");
  git(template, "checkout", "-q", "-");
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
  git(template, "checkout", "-q", FROM);
  const dir = project("refusals");
  git(template, "checkout", "-q", "-");
  assert.throws(() => run(dir, { to: "newest" }), UpdateError);
  writeFileSync(join(dir, "README.md"), "uncommitted\n");
  assert.throws(() => run(dir), /uncommitted changes/);
});

test("the origin line is read whichever release wrote it, and the highest version wins", () => {
  const changelog = [
    "## [Unreleased]",
    "",
    "- Updated to [ULTRA-TEMPLATE v1.4.0](https://github.com/hynix666/ULTRA-TEMPLATE/releases/tag/v1.4.0).",
    "- Initialized from [ULTRA-TEMPLATE v1.2.0](https://github.com/hynix666/ULTRA-TEMPLATE/releases/tag/v1.2.0) with go-service, release.",
  ].join("\n");
  // The newer line sits above the older one; the highest version wins, not the last line.
  const origin = readOrigin(changelog);
  assert.equal(origin.version, "v1.4.0");
  assert.deepEqual(origin.features, ["go-service", "release"]);
  assert.equal(compareVersions("v1.10.0", "v1.9.9") > 0, true, "numeric, not lexical");
  assert.equal(readOrigin(recordUpdate("## [Unreleased]\n\n- Initialized from [ULTRA-TEMPLATE v1.3.1](https://github.com/hynix666/ULTRA-TEMPLATE/releases/tag/v1.3.1) with no features.\n", "https://github.com/hynix666/ULTRA-TEMPLATE", "v1.4.0")).version, "v1.4.0");
  assert.deepEqual(remoteIdentity("git@github.com:octo-org/demo-app.git"), { owner: "octo-org", repo: "demo-app" });
  assert.equal(remoteIdentity("https://gitlab.com/octo-org/demo-app"), null);
});

/** A project made from the first release with `features`, and the template left at its newest release. */
function withFeatures(name, features) {
  git(template, "checkout", "-q", FROM);
  const dir = project(name, features);
  git(template, "checkout", "-q", "-");
  return dir;
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
  // Still on the release it was on; only the selection moved.
  const origin = readOrigin(readFileSync(join(dir, "CHANGELOG.md"), "utf8"));
  assert.equal(origin.version, FROM);
  assert.deepEqual(origin.features, ["release"]);
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
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /Updated to \[ULTRA-TEMPLATE v[\d.]+\]\([^)]+\) with ts-library, release\./);
});

test("a selection change and a release move are one update", () => {
  const dir = withFeatures("both", []);
  const result = select(dir, { to: TO, add: ["release"] });
  assert.deepEqual(result.conflicts, []);
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
  assert.equal(existsSync(join(dir, ".github/workflows/release.yml")), true);
  const origin = readOrigin(readFileSync(join(dir, "CHANGELOG.md"), "utf8"));
  assert.equal(origin.version, TO);
  assert.deepEqual(origin.features, ["release"]);
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
  assert.throws(() => select(dir, { add: ["kubernetes"] }), /v[\d.]+ defines no feature kubernetes\. It defines: go-service/);
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

test("the selection is read from the newest line that names one, and the first of two at one version", () => {
  const url = "https://github.com/hynix666/ULTRA-TEMPLATE";
  const line = (kind, version, features) => `- ${kind} [ULTRA-TEMPLATE ${version}](${url}/releases/tag/${version})${features ? ` with ${features}` : ""}.`;
  const changelog = [
    "## [Unreleased]",
    "",
    line("Updated to", "v1.3.0"),
    line("Updated to", "v1.2.0", "web, release"),
    line("Updated to", "v1.2.0", "release"),
    line("Initialized from", "v1.1.0", "go-service, release"),
  ].join("\n");
  const origin = readOrigin(changelog);
  assert.equal(origin.version, "v1.3.0");
  assert.deepEqual(origin.features, ["web", "release"]);
  assert.match(recordUpdate("## [Unreleased]\n", url, "v1.3.0", []), /v1\.3\.0\) with no features\./);
  assert.doesNotMatch(recordUpdate("## [Unreleased]\n", url, "v1.3.0"), / with /);
});

test("recorded identity reconstructs a project after package.json is removed", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("unnamed");
  git(template, "checkout", "-q", "-");
  rmSync(join(dir, "package.json"));
  commit(dir, "chore: no root package.json");
  assert.equal(run(dir).status, "applied");
});

test("each release is named with the commit its tag points at, before its init runs", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("named-commits");
  git(template, "checkout", "-q", "-");
  const lines = [];
  run(dir, { log: (line) => lines.push(line) });
  for (const tag of [FROM, TO]) {
    const sha = git(template, "rev-parse", `${tag}^{commit}`).trim();
    assert.ok(lines.some((line) => line.includes(`${tag} is commit ${sha}`)), `${tag} ${sha} not in:\n${lines.join("\n")}`);
  }
});

test("run from a subdirectory, it updates the whole project", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("from-below");
  git(template, "checkout", "-q", "-");
  const below = join(dir, "docs");
  const result = spawnSync(process.execPath, [join(dir, "scripts/template-update.mjs"), "--to", TO, "--template", template, "--owner", "octo-org", "--repo", "demo-app"], { cwd: below, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "SECURITY.md"), "utf8"), new RegExp(NOTE));
});

test("--check reports a newer release and the command that takes it, without touching the tree", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("check-behind");
  git(template, "checkout", "-q", "-");
  writeFileSync(join(dir, "README.md"), `${readFileSync(join(dir, "README.md"), "utf8")}\nUncommitted.\n`);

  const report = checkForUpdate({ project: dir, template });

  assert.equal(report.schema, 1);
  assert.deepEqual(report.current, { version: FROM, source: "provenance" });
  assert.deepEqual(report.latest, { version: TO });
  assert.equal(report.updateAvailable, true);
  assert.equal(report.command, `node scripts/template-update.mjs --to ${TO}`);
  assert.equal(git(dir, "status", "--porcelain").trim(), "M README.md");
});

test("--check on the newest release says so", () => {
  git(template, "checkout", "-q", TO);
  const dir = project("check-current");
  git(template, "checkout", "-q", "-");

  const report = checkForUpdate({ project: dir, template });

  assert.deepEqual(report.current, { version: TO, source: "provenance" });
  assert.equal(report.updateAvailable, false);
});

test("--check reads CHANGELOG.md when a legacy project predates the provenance record", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("check-legacy");
  git(template, "checkout", "-q", "-");
  rmSync(join(dir, PROVENANCE_FILE));
  commit(dir, "chore: a project from before provenance");

  const report = checkForUpdate({ project: dir, template });

  assert.deepEqual(report.current, { version: FROM, source: "changelog" });
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
  rmSync(join(silent, "CHANGELOG.md"));
  assert.throws(() => checkForUpdate({ project: silent, template }), /CHANGELOG.md is missing/);
});

test("--check on a template it cannot reach is an error, never a silent no", () => {
  const dir = project("check-unreachable");
  assert.throws(
    () => checkForUpdate({ project: dir, template: join(work, "no-such-template") }),
    (err) => err instanceof UpdateError && /cannot list the releases/.test(err.message),
  );
});

test("--check exits 1 when a newer release is out and 0 at the newest, and takes no update option", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("check-main");
  git(template, "checkout", "-q", "-");
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

test("a file the release adds that the project already has, byte for byte, is not in the way; --to latest takes the newest release", () => {
  git(template, "checkout", "-q", FROM);
  const dir = project("already-has-it");
  git(template, "checkout", "-q", "-");
  // A later release that adds a file, which this project happened to add itself, identically.
  const LATEST = `v${major}.${minor + 2}.0`;
  const added = "## Support\n\nAsk in the discussions.\n";
  writeFileSync(join(template, "SUPPORT.md"), added);
  const manifest = join(template, "template/features.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"version": "${TO.slice(1)}"`, `"version": "${LATEST.slice(1)}"`));
  git(template, "add", "-A");
  commit(template, "a release that adds a file");
  git(template, "tag", LATEST);
  writeFileSync(join(dir, "SUPPORT.md"), added);
  git(dir, "add", "-A");
  commit(dir, "docs: support");

  const result = run(dir, { to: "latest" });

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.to, LATEST);
  assert.ok(!result.changed.some((line) => line.endsWith(" SUPPORT.md")), `SUPPORT.md is not a change: ${result.changed.join(", ")}`);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), new RegExp(`Updated to \\[[^\\]]+ ${LATEST.replaceAll(".", "\\.")}\\]`));
});
