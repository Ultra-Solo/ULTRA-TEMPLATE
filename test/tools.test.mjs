// The tool manifest and its installer must be seen to refuse: a download whose SHA-256 is not the
// pinned one, a manifest entry that says nothing about where its checksum comes from.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bump, chassisToolPlan, command, helperProblems, install, loadTools, localPlan, localTools, platform, toolsFor, validateTools, withHelpers } from "../scripts/tools.mjs";

/** A tar.gz (or, with `xz`, a tar.xz) holding one executable, its bytes, and a fetch that serves it at `url`. */
function release(t, url, member = "demo", { xz = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), "tools-test-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(dirname(join(work, "src", member)), { recursive: true });
  writeFileSync(join(work, "src", member), "#!/bin/sh\necho demo 1.2.3\n");
  const archive = join(work, xz ? "demo.tar.xz" : "demo.tar.gz");
  assert.equal(spawnSync("tar", [xz ? "-cJf" : "-czf", archive, "-C", join(work, "src"), member]).status, 0);
  const bytes = readFileSync(archive);
  const fetch = async (address) => (address === url ? new Response(bytes) : new Response("", { status: 404 }));
  return { work, bytes, sha: createHash("sha256").update(bytes).digest("hex"), fetch };
}

const tool = (url, sha, extra = {}) => ({
  demo: {
    version: "1.2.3",
    for: "chassis",
    releases: { github: "octo/demo" },
    platforms: { [platform()]: { url, sha256: sha, files: ["demo"] } },
    checksums: { file: "https://example.test/v{version}/checksums.txt" },
    ...extra,
  },
});

test("the repository's own manifest is well formed", () => {
  assert.deepEqual(validateTools(loadTools()), []);
});

test("a tool installs when its SHA-256 is the pinned one", async (t) => {
  const url = "https://example.test/v1.2.3/demo.tar.gz";
  const { work, sha, fetch } = release(t, url);
  const written = await install("demo", { tools: tool("https://example.test/v{version}/demo.tar.gz", sha), dir: join(work, "bin"), fetch });
  assert.deepEqual(written, [join(work, "bin", "demo")]);
});

test("a download whose SHA-256 differs is refused, and nothing is unpacked", async (t) => {
  const url = "https://example.test/v1.2.3/demo.tar.gz";
  const { work, fetch } = release(t, url);
  const pinned = "0".repeat(64);
  await assert.rejects(
    () => install("demo", { tools: tool("https://example.test/v{version}/demo.tar.gz", pinned), dir: join(work, "bin"), fetch }),
    /has SHA-256 [0-9a-f]{64}, not the pinned 0{64}\. The asset was replaced, or the pin is wrong: nothing was unpacked/,
  );
  assert.equal(existsSync(join(work, "bin")), false);
});

test("an entry that says nothing about where its checksum comes from, or is both kinds of tool, is refused", () => {
  const bad = tool("https://example.test/x.tar.gz", "a".repeat(64), { checksums: {}, run: ["demo"] });
  const found = validateTools(bad).join("\n");
  assert.match(found, /either downloaded \(`platforms`\) or run by version/);
  assert.match(found, /`checksums` must say where the release publishes its checksum/);
  assert.match(validateTools({ x: { version: "1.2", for: "moon", releases: {}, run: ["x"] } }).join("\n"), /version` must be X\.Y\.Z.*\n.*`for` must be one of.*\n.*`releases` must name/);
});

test("a command a check uses is named when it is missing, and held to its pin when this manifest pins it", () => {
  const url = "https://example.test/x.tar.gz";
  const check = { check: ["demo", "--strict"], uses: ["helper"] };
  assert.deepEqual(validateTools(tool(url, "a".repeat(64), check)), []);
  assert.deepEqual(helperProblems(check, { tools: {}, has: () => false }), [{ helper: "helper", missing: true }]);
  assert.deepEqual(helperProblems(check, { tools: {}, has: () => true }), []);
  assert.deepEqual(helperProblems({ check: ["demo"] }, { tools: {}, has: () => false }), [], "a check that uses nothing is missing nothing");
  const pinned = { helper: { version: "2.0.0", versionCommand: ["helper", "--version"] } };
  assert.deepEqual(helperProblems(check, { tools: pinned, found: () => null }), [{ helper: "helper", missing: true }]);
  assert.deepEqual(helperProblems(check, { tools: pinned, found: () => "2.0.0" }), []);
  assert.match(helperProblems(check, { tools: pinned, found: () => "1.9.0" })[0].wrong, /helper 1\.9\.0 is on PATH, but scripts\/tools\/tools\.json pins 2\.0\.0/);
  for (const uses of [[], ["a helper"], "helper", [""]]) {
    assert.match(validateTools(tool(url, "a".repeat(64), { ...check, uses })).join(), /`uses` lists the commands a tool's `check` runs/, JSON.stringify(uses));
  }
  assert.match(validateTools(tool(url, "a".repeat(64), { uses: ["helper"] })).join(), /`uses` lists/, "a tool with no check uses nothing");
});

test("a helper this manifest pins is installable wherever the tool that uses it is, and is installed with it", () => {
  const url = "https://example.test/x.tar.gz";
  const both = { ...tool(url, "a".repeat(64), { check: ["demo"], uses: ["helper"] }), helper: tool(url, "b".repeat(64)).demo };
  assert.deepEqual(validateTools(both), []);
  const needs = /`uses` helper, which this manifest pins, so it needs `for` "chassis" and an asset for every platform demo has/;
  assert.match(validateTools({ ...both, helper: { ...both.helper, for: "ci" } }).join(), needs);
  assert.match(validateTools({ ...both, helper: { ...both.helper, platforms: {} } }).join(), needs);
  assert.deepEqual(withHelpers(["demo"], both), ["demo", "helper"]);
  assert.deepEqual(withHelpers(["helper", "demo"], both), ["helper", "demo"], "each once");
  assert.deepEqual(withHelpers(["demo"], { demo: both.demo }), ["demo"], "a helper this manifest does not pin is not installed");
});

// No tool is installed on a platform the manifest pins no asset for, and there tar may not write xz.
const installsHere = Object.values(loadTools()).some((entry) => platform() in (entry.platforms ?? {}));

test("an xz archive installs as a gzip one does, from a directory inside it, and is refused when its SHA-256 differs", { skip: !installsHere && `no tool is installed on ${platform()}` }, async (t) => {
  const url = "https://example.test/v1.2.3/demo.tar.xz";
  const { work, sha, fetch } = release(t, url, "demo-v1.2.3/demo", { xz: true });
  const pin = (sha256) => tool("https://example.test/v{version}/demo.tar.xz", sha256, { platforms: { [platform()]: { url: "https://example.test/v{version}/demo.tar.xz", sha256, files: ["demo-v{version}/demo"] } } });
  assert.deepEqual(await install("demo", { tools: pin(sha), dir: join(work, "bin"), fetch }), [join(work, "bin", "demo")]);
  await assert.rejects(() => install("demo", { tools: pin("0".repeat(64)), dir: join(work, "other"), fetch }), /not the pinned 0{64}\. The asset was replaced, or the pin is wrong: nothing was unpacked/);
  assert.equal(existsSync(join(work, "other")), false);
});

test("verify runs each chassis tool it finds at its pin, and a missing one fails where CI must run it", () => {
  const asset = { url: "https://example.test/lint.tar.gz", sha256: "a".repeat(64), files: ["lint"] };
  const tools = {
    lint: { version: "1.0.0", for: "chassis", releases: { github: "o/lint" }, platforms: { "linux-x64": asset }, checksums: { file: "x" }, versionCommand: ["lint", "--version"], check: ["lint", "-strict"] },
    other: { version: "2.0.0", for: "go", releases: { github: "o/other" }, platforms: { "linux-x64": asset }, checksums: { file: "x" }, check: ["other"] },
  };
  const plan = (found, options = {}) => chassisToolPlan(tools, { found: () => found, on: "linux-x64", helpers: () => [], ...options });
  assert.deepEqual(plan("1.0.0"), [{ name: "chassis: lint", run: ["lint", "-strict"] }], "only chassis tools with a check");
  assert.match(plan("0.9.0")[0].note, /lint 0\.9\.0 is on PATH, but scripts\/tools\/tools\.json pins 1\.0\.0/);
  assert.equal(plan("0.9.0")[0].status, "fail");
  // Missing: a failure where the caller says a skip fails (CI), a named skip elsewhere.
  assert.equal(plan(null, { missing: "fail" })[0].status, "fail");
  assert.equal(plan(null, { missing: "skipped" })[0].status, "skipped");
  assert.match(plan(null)[0].note, /node scripts\/tools\.mjs install --local installs it/);
  // With no asset for this platform nothing can install it, so it is only ever skipped, and says why.
  const elsewhere = plan(null, { on: "win32-x64", missing: "fail" })[0];
  assert.equal(elsewhere.status, "skipped");
  assert.match(elsewhere.note, /no pinned asset for win32-x64/);
  // A helper at another version stops the run; a missing one is recorded after it.
  const wrong = plan("1.0.0", { helpers: () => [{ helper: "sc", wrong: "sc 0.1.0 is on PATH" }] });
  assert.deepEqual(wrong.map((e) => [e.name, e.status ?? "run"]), [["chassis: lint with sc", "fail"]]);
  const missingHelper = plan("1.0.0", { missing: "fail", helpers: () => [{ helper: "sc", missing: true }] });
  assert.deepEqual(missingHelper.map((e) => [e.name, e.status ?? "run"]), [["chassis: lint", "run"], ["chassis: lint with sc", "fail"]]);
});

test("a tool run by version is run with the pinned version filled in", () => {
  const tools = { audit: { version: "4.5.6", for: "ci", releases: { pypi: "audit" }, run: ["uvx", "audit=={version}"] } };
  assert.deepEqual(command("audit", ["--strict"], tools), ["uvx", "audit==4.5.6", "--strict"]);
});

test("a checkout needs the chassis's tools, and those of the toolchains its modules use", () => {
  const tools = loadTools();
  const minimal = localTools([], tools);
  const withGo = localTools(["go"], tools);
  assert.ok(minimal.every((name) => tools[name].for === "chassis"));
  assert.ok(withGo.some((name) => tools[name].for === "go"));
  assert.ok(!withGo.some((name) => tools[name].for === "ci"), "CI-only tools are never installed locally");
});

test("bump takes the new checksum from the release, never from anyone's copy", async () => {
  const sha = "b".repeat(64);
  const tools = tool("https://example.test/v{version}/demo.tar.gz", "a".repeat(64));
  const fetch = async (address) =>
    address === "https://example.test/v2.0.0/checksums.txt" ? new Response(`${"c".repeat(64)}  other.tar.gz\n${sha}  demo.tar.gz\n`) : new Response("", { status: 404 });
  const next = await bump("demo", "2.0.0", { tools, fetch });
  assert.equal(next.demo.version, "2.0.0");
  assert.equal(next.demo.platforms[platform()].sha256, sha);
  await assert.rejects(() => bump("demo", "2.0.1", { tools, fetch }), /answered 404/);
});

test("bump reads a sidecar checksum beside each platform's own asset", async () => {
  const sha = "d".repeat(64);
  const tools = tool("https://example.test/v{version}/demo.tar.gz", "a".repeat(64), { checksums: { sidecar: ".sha256" } });
  const fetch = async (address) =>
    address === "https://example.test/v2.0.0/demo.tar.gz.sha256" ? new Response(`${sha}  demo.tar.gz\n`) : new Response("", { status: 404 });
  assert.equal((await bump("demo", "2.0.0", { tools, fetch })).demo.platforms[platform()].sha256, sha);
  assert.match(validateTools(tool("https://example.test/x.tar.gz", "a".repeat(64), { checksums: { sidecar: "https://example.test/x.sha256" } })).join(), /`checksums.sidecar` is the suffix/);
});

test("a local install leaves a tool already at its pin alone, and names one this platform has no asset for", () => {
  const tools = {
    ...tool("https://example.test/demo.tar.gz", "a".repeat(64)),
    other: { ...tool("https://example.test/other.tar.gz", "a".repeat(64)).demo, platforms: { "plan9-mips": { url: "https://example.test/o", sha256: "a".repeat(64), files: ["o"] } } },
  };
  const plan = (versions) => localPlan(["demo", "other"], { tools, on: platform(), found: (name) => versions[name] ?? null });
  assert.deepEqual(plan({}).install, ["demo"]);
  assert.match(plan({}).skipped.join(), new RegExp(`other has no pinned asset for ${platform()}: install 1\\.2\\.3 yourself`));
  assert.deepEqual(plan({ demo: "1.2.3" }).install, []);
  assert.match(plan({ demo: "1.2.3" }).skipped.join(), /demo 1\.2\.3 is already on PATH/);
  assert.deepEqual(plan({ demo: "1.2.2" }).install, ["demo"], "a different version on PATH is replaced by the pinned one");
});

test("a module's CI job installs the tools of its toolchains, and neither the chassis's nor CI-only ones", () => {
  const tools = loadTools();
  const go = toolsFor(["go"], tools);
  assert.ok(go.length > 0 && go.every((name) => tools[name].for === "go"));
  assert.deepEqual(toolsFor([], tools), []);
  assert.deepEqual(toolsFor(["chassis", "ci"], tools).filter((name) => !tools[name].platforms), []);
});
