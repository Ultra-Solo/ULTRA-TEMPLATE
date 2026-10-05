import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

/** A throwaway tree holding the named files, for fixtures the doctor has to read. */
const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
};

/** A throwaway git repository with one commit, so the working tree starts clean. */
const gitRepo = (files) => {
  const root = fixture(files);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]);
  git(["-c", "user.name=doctor", "-c", "user.email=doctor@localhost", "add", "-A"]);
  git(["-c", "user.name=doctor", "-c", "user.email=doctor@localhost", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  return root;
};

const manifest = (extra = {}) =>
  JSON.stringify({ id: "fixture", toolchain: "node", checks: [{ name: "t", run: ["node", "--version"] }], ...extra });

/** A tools manifest whose one entry passes validateTools, so the pinned-tool checks have something to read. */
const tools = (extra = {}) =>
  JSON.stringify({
    tools: {
      tool: {
        version: "1.2.3",
        for: "node",
        releases: { github: "example/tool" },
        platforms: {
          "linux-x64": {
            url: "https://github.com/example/tool/releases/download/v{version}/tool",
            sha256: "a".repeat(64),
            files: ["tool"],
          },
        },
        checksums: { githubDigest: true },
        versionCommand: ["tool", "--version"],
        ...extra,
      },
    },
  });

const provenance = () =>
  JSON.stringify({
    schemaVersion: 1,
    source: { url: "https://github.com/Ultra-Solo/ULTRA-TEMPLATE", version: "v3.4.0", commit: "a".repeat(40), tag: "v3.4.0" },
    inputs: {
      identity: { name: "demo-app", owner: "octo-org", repo: "demo-app" },
      features: ["go-service"],
      year: 2025,
      description: { generated: true, sentence: "Starts as a Go task API." },
    },
  });

// The bracket names the template generically because this file ships to generated projects, where
// identity replacement would rewrite the template's repository name into the project's own.
const CHANGELOG =
  "- Initialized from [template v3.4.0](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v3.4.0) with go-service.\n";

const find = (report, id) => report.checks.find((entry) => entry.id === id);
const clean = (...roots) => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
};

test("the Node check passes on the pinned major, fails on another, and is unknown without .node-version", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const major = process.versions.node.split(".")[0];
  const pinned = fixture({ ".node-version": `v${major}\n` });
  const wrong = fixture({ ".node-version": "v18\n" });
  const none = fixture({});
  try {
    assert.equal(find(diagnose(pinned), "node-version").status, "pass");
    const failing = find(diagnose(wrong), "node-version");
    assert.equal(failing.status, "fail");
    assert.match(failing.detail, /pins Node 18/);
    assert.equal(find(diagnose(none), "node-version").status, "unknown");
  } finally {
    clean(pinned, wrong, none);
  }
});

test("without git on PATH, git-present fails and git-clean is unknown", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const root = fixture({});
  try {
    const report = diagnose(root, { has: () => false });
    assert.equal(find(report, "git-present").status, "fail");
    assert.equal(find(report, "git-clean").status, "unknown");
  } finally {
    clean(root);
  }
});

test("a clean tree passes, a dirty one fails, and a directory outside git is unknown", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const cleanTree = gitRepo({});
  const dirty = gitRepo({});
  writeFileSync(join(dirty, "uncommitted.txt"), "change\n");
  const outside = fixture({});
  try {
    assert.equal(find(diagnose(cleanTree), "git-clean").status, "pass");
    const failing = find(diagnose(dirty), "git-clean");
    assert.equal(failing.status, "fail");
    assert.match(failing.detail, /template-update refuses to run until they are committed or stashed/);
    assert.equal(find(diagnose(outside), "git-clean").status, "unknown");
  } finally {
    clean(cleanTree, dirty, outside);
  }
});

test("the modules check names the modules present, and fails over a malformed manifest", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const good = fixture({ "svc/module.json": manifest() });
  const bad = fixture({ "svc/module.json": "{ not json" });
  const none = fixture({});
  try {
    assert.match(find(diagnose(good), "modules").detail, /1 module\(s\): fixture/);
    const failing = find(diagnose(bad), "modules");
    assert.equal(failing.status, "fail");
    assert.match(failing.detail, /is not valid JSON/);
    assert.match(find(diagnose(none), "modules").detail, /no modules are present/);
  } finally {
    clean(good, bad, none);
  }
});

test("a module fails over a missing toolchain, files or installed directory", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const root = fixture({ "svc/module.json": manifest() });
  try {
    const report = diagnose(root, { has: () => false });
    const toolchain = find(report, "module:fixture:toolchain");
    assert.equal(toolchain.status, "fail");
    assert.match(toolchain.detail, /npm is not on PATH/);
    const files = find(report, "module:fixture:files");
    assert.equal(files.status, "fail");
    assert.match(files.detail, /svc is missing package\.json and package-lock\.json/);
    const installed = find(report, "module:fixture:installed");
    assert.equal(installed.status, "fail");
    assert.match(installed.detail, /run node scripts\/setup\.mjs/);
  } finally {
    clean(root);
  }
});

test("a module with its files and dependencies present passes, and a Go module installs no directory", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const node = fixture({
    "svc/module.json": manifest(),
    "svc/package.json": "{}",
    "svc/package-lock.json": "{}",
    "svc/node_modules/.keep": "",
  });
  const go = fixture({ "svc/module.json": manifest({ toolchain: "go" }), "svc/go.mod": "module example.com/fixture\n" });
  try {
    const report = diagnose(node);
    assert.equal(find(report, "module:fixture:toolchain").status, "pass");
    assert.equal(find(report, "module:fixture:files").status, "pass");
    assert.equal(find(report, "module:fixture:installed").status, "pass");
    const goReport = diagnose(go);
    assert.equal(find(goReport, "module:fixture:files").status, "pass");
    assert.equal(find(goReport, "module:fixture:installed").status, "not-applicable");
  } finally {
    clean(node, go);
  }
});

test("without scripts/tools/tools.json no tool is pinned, and a malformed manifest fails", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const none = fixture({});
  const malformed = fixture({ "scripts/tools/tools.json": "{ not json" });
  try {
    assert.equal(find(diagnose(none), "pinned-tools").status, "not-applicable");
    const failing = find(diagnose(malformed), "pinned-tools");
    assert.equal(failing.status, "fail");
    assert.match(failing.detail, /scripts\/tools\/tools\.json cannot be used/);
  } finally {
    clean(none, malformed);
  }
});

test("a pinned tool passes at its pin, fails at another version, and is unknown when not on PATH", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const root = fixture({ "svc/module.json": manifest(), "scripts/tools/tools.json": tools() });
  const noCommand = fixture({ "svc/module.json": manifest(), "scripts/tools/tools.json": tools({ versionCommand: undefined }) });
  try {
    const atPin = diagnose(root, { toolVersion: () => "1.2.3" });
    assert.equal(find(atPin, "pinned-tools").status, "pass");
    assert.equal(find(atPin, "pinned-tool:tool").status, "pass");
    const wrong = diagnose(root, { toolVersion: () => "9.9.9" });
    assert.equal(find(wrong, "pinned-tool:tool").status, "fail");
    assert.match(find(wrong, "pinned-tool:tool").detail, /pins 1\.2\.3/);
    const absent = diagnose(root, { toolVersion: () => null });
    assert.equal(find(absent, "pinned-tool:tool").status, "unknown");
    assert.match(find(absent, "pinned-tool:tool").detail, /install --local/);
    const silent = diagnose(noCommand, { toolVersion: () => null });
    assert.equal(find(silent, "pinned-tool:tool").status, "unknown");
    assert.match(find(silent, "pinned-tool:tool").detail, /names no version command/);
  } finally {
    clean(root, noCommand);
  }
});

test("a provenance record is the template source, a CHANGELOG line the legacy one, and neither is a failure to update", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const modern = fixture({ ".template-provenance.json": provenance() });
  const legacy = fixture({ "CHANGELOG.md": CHANGELOG });
  const malformed = fixture({ ".template-provenance.json": "{ not json" });
  const changelogOnly = fixture({ "CHANGELOG.md": "## [Unreleased]\n\nNothing yet.\n" });
  const neither = fixture({});
  try {
    const source = find(diagnose(modern), "template-source");
    assert.equal(source.status, "pass");
    assert.match(source.detail, /records the template at v3\.4\.0/);
    const update = find(diagnose(modern), "update");
    assert.equal(update.status, "unknown");
    assert.match(update.detail, /template-update\.mjs --check/);
    const old = find(diagnose(legacy), "template-source");
    assert.equal(old.status, "pass");
    assert.match(old.detail, /legacy baseline: CHANGELOG\.md records v3\.4\.0/);
    const broken = find(diagnose(malformed), "template-source");
    assert.equal(broken.status, "fail");
    assert.match(broken.detail, /is not valid JSON/);
    assert.equal(find(diagnose(malformed), "update").status, "not-applicable");
    const unreadable = find(diagnose(changelogOnly), "template-source");
    assert.equal(unreadable.status, "fail");
    assert.match(unreadable.detail, /has no "Initialized from" line/);
    const missing = find(diagnose(neither), "template-source");
    assert.equal(missing.status, "fail");
    assert.match(missing.detail, /neither \.template-provenance\.json nor CHANGELOG\.md records/);
  } finally {
    clean(modern, legacy, malformed, changelogOnly, neither);
  }
});

test("the template itself has no source and does not update", async () => {
  const { diagnose } = await import("../scripts/doctor.mjs");
  const root = fixture({ "template/features.json": "{}" });
  try {
    const report = diagnose(root);
    assert.equal(find(report, "template-source").status, "not-applicable");
    assert.equal(find(report, "update").status, "not-applicable");
  } finally {
    clean(root);
  }
});

test("main prints one JSON report and exits by what failed", async () => {
  const { main } = await import("../scripts/doctor.mjs");
  const major = process.versions.node.split(".")[0];
  const healthy = gitRepo({ ".node-version": `v${major}\n`, "CHANGELOG.md": CHANGELOG });
  const failing = fixture({});
  const said = [];
  const errors = [];
  const log = (text) => said.push(text);
  const originalError = console.error;
  console.error = (text) => errors.push(text);
  try {
    assert.equal(main([], { root: healthy, log }), 0);
    const report = JSON.parse(said.join(""));
    assert.equal(report.schema, 1);
    assert.deepEqual(Object.keys(report), ["schema", "project", "checks"]);
    assert.equal(report.project.root, healthy);
    assert.equal(report.project.node, process.versions.node);
    assert.deepEqual(report.project.modules, []);
    for (const entry of report.checks) {
      assert.ok(["pass", "fail", "unknown", "not-applicable"].includes(entry.status));
      assert.deepEqual(Object.keys(entry), ["id", "status", "detail"]);
    }
    said.length = 0;
    assert.equal(main([], { root: failing, log }), 1);
    assert.equal(
      JSON.parse(said.join("")).checks.some((entry) => entry.status === "fail"),
      true,
    );
    assert.equal(main(["--whatever"], { root: failing, log }), 2);
    assert.match(errors.join(" "), /takes no arguments/);
  } finally {
    console.error = originalError;
    clean(healthy, failing);
  }
});
