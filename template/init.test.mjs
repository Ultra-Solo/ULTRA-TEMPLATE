import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { sourceFixture } from "./test-source.mjs";
import { presentModules } from "../scripts/modules.mjs";
import { checkGate } from "../scripts/check-hygiene.mjs";
import {
  applyMarkers, DESCRIPTION_ANCHOR, describeProject, InitError, loadManifest, MARKER_RE, originDefaults, originIdentity, plan, recordDescription,
  removedPaths, replaceIdentity, resolveSelection, ROOT, toProjectName, validateDescription, validateIdentity, validateManifest,
} from "./init.mjs";

let source;
before(() => { source = sourceFixture(ROOT, loadManifest().version); });
after(() => rmSync(source, { recursive: true, force: true }));

test("the template's own remote is never used as the project's identity", () => {
  const manifest = loadManifest();
  assert.equal(originDefaults(manifest, "git@github.com:Ultra-Solo/ULTRA-TEMPLATE.git"), null);
  assert.equal(originDefaults(manifest, "https://github.com/ULTRA-SOLO/ultra-template"), null);
  assert.deepEqual(originDefaults(manifest, "git@github.com:octo-org/demo-app.git"), { owner: "octo-org", repo: "demo-app" });
});

test("the owner and repository default from a GitHub origin remote", () => {
  assert.deepEqual(originIdentity("git@github.com:octo-org/My.Repo.git"), { owner: "octo-org", repo: "My.Repo" });
  assert.deepEqual(originIdentity("https://github.com/octo-org/demo-app"), { owner: "octo-org", repo: "demo-app" });
  assert.equal(originIdentity("https://gitlab.com/octo-org/demo-app.git"), null);
  assert.equal(originIdentity(""), null);
  assert.equal(toProjectName("My.Repo__Name"), "my-repo-name");
});

test("the current upstream is recognized without borrowing its repository name", () => {
  const manifest = loadManifest();
  assert.equal(originDefaults(manifest, "https://github.com/Ultra-Solo/ULTRA-TEMPLATE.git"), null);
  assert.equal(originDefaults(manifest, "git@github.com:ultra-solo/ultra-template.git"), null);
  assert.deepEqual(originDefaults(manifest, "https://github.com/octo-org/My.Service.git"), { owner: "octo-org", repo: "My.Service" });
});

test("a mixed-case template owner rewrites lowercase registry identities too", () => {
  const from = { owner: "Ultra-Solo", repo: "ULTRA-TEMPLATE", name: "ultra-template" };
  const to = { owner: "Octo-Org", repo: "My.Service", name: "demo-app" };
  const text = "@ultra-solo/ultra-template ghcr.io/ultra-solo/ultra-template-mcp-server io.github.ultra-solo/ultra-template github.com/Ultra-Solo/ULTRA-TEMPLATE";
  assert.equal(replaceIdentity(text, from, to), "@octo-org/demo-app ghcr.io/octo-org/demo-app-mcp-server io.github.octo-org/demo-app github.com/Octo-Org/My.Service");
});

test("generated licenses keep the upstream notice alongside the adopter's copyright", () => {
  const manifest = loadManifest();
  const identity = { name: "demo-app", owner: "octo", repo: "demo-app" };
  const license = plan(ROOT, manifest, new Set(), identity, undefined, 2031).files.find((f) => f.file === "LICENSE");
  assert.match(license.data, /^Copyright \(c\) 2031 octo$/m);
  assert.match(license.data, /^Copyright \(c\) 2026 hynix666$/m);
});

// Built by concatenation so this file never contains a marker line of its own.
const begin = (id) => `# ultra:${"begin"} ${id}`;
const end = (id) => `# ultra:${"end"} ${id}`;
const known = new Set(["go-service", "web"]);

test("selected blocks keep their content and lose their marker lines; the rest disappears", () => {
  const text = ["a", begin("go-service"), "go", end("go-service"), begin("web"), "web", end("web"), "z"].join("\n");
  assert.equal(applyMarkers(text, new Set(["web"]), known), "a\nweb\nz");
});

test("removing blocks between blank lines leaves a single blank line", () => {
  const text = ["a", "", begin("web"), "web", end("web"), "", begin("go-service"), "go", end("go-service"), "", "b"].join("\n");
  assert.equal(applyMarkers(text, new Set(), known), "a\n\nb");
  assert.equal(applyMarkers(text, new Set(["web"]), known), "a\n\nweb\n\nb");
});

test("template blocks are always removed", () => {
  assert.equal(applyMarkers(["a", begin("template"), "only here", end("template")].join("\n"), new Set(["web"]), known), "a");
});

test("a block joined to several features is kept when any one of them is selected", () => {
  const any = "go-service|web";
  const text = ["a", begin(any), "shared", end(any), "z"].join("\n");
  assert.equal(applyMarkers(text, new Set(["web"]), known), "a\nshared\nz");
  assert.equal(applyMarkers(text, new Set(["go-service"]), known), "a\nshared\nz");
  assert.equal(applyMarkers(text, new Set(["go-service", "web"]), known), "a\nshared\nz");
  assert.equal(applyMarkers(text, new Set(), known), "a\nz");
});

test("a block joined with & is kept only when every one of its features is selected", () => {
  const both = "web&go-service";
  const text = ["a", begin(both), "calls", end(both), "z"].join("\n");
  assert.equal(applyMarkers(text, new Set(["web", "go-service"]), known), "a\ncalls\nz");
  assert.equal(applyMarkers(text, new Set(["web"]), known), "a\nz");
  assert.equal(applyMarkers(text, new Set(["go-service"]), known), "a\nz");
  assert.equal(applyMarkers(text, new Set(), known), "a\nz");
});

test("a joined block is malformed on an unknown id, a different end, the reserved id, or | and & mixed", () => {
  const cases = {
    unknown: [begin("web|nope"), end("web|nope")],
    unknownAll: [begin("web&nope"), end("web&nope")],
    mixed: [begin("web|go-service&web"), end("web|go-service&web")],
    reservedAll: [begin("web&template"), end("web&template")],
    otherJoiner: [begin("web&go-service"), end("web|go-service")],
    // The end names the same ids in the same order, so a half-edited pair is an error, not a guess.
    reordered: [begin("web|go-service"), end("go-service|web")],
    partial: [begin("web|go-service"), end("web")],
    reserved: [begin("web|template"), end("web|template")],
  };
  for (const [name, lines] of Object.entries(cases)) {
    assert.throws(() => applyMarkers(lines.join("\n"), new Set(["web"]), known, name), InitError, name);
  }
});

test("malformed markers throw instead of deleting the rest of the file", () => {
  const cases = {
    unknown: [begin("nope"), end("nope")],
    nested: [begin("web"), begin("go-service"), end("go-service"), end("web")],
    unclosed: [begin("web"), "x"],
    mismatched: [begin("web"), end("go-service")],
  };
  for (const [name, lines] of Object.entries(cases)) {
    assert.throws(() => applyMarkers(lines.join("\n"), known, known, name), InitError, name);
  }
});

test("identity replacement never rewrites its own output", () => {
  const from = { owner: "hynix666", repo: "ULTRA-TEMPLATE", name: "ultra-template" };
  const to = { owner: "octo", repo: "hynix666-app", name: "ultra-template-x" };
  const text = "github.com/hynix666/ULTRA-TEMPLATE module github.com/hynix666/ultra-template @hynix666";
  assert.equal(replaceIdentity(text, from, to), "github.com/octo/hynix666-app module github.com/octo/ultra-template-x @octo");
});

test("an npm scope is lowercased, since npm rejects capitals, while GitHub names keep the owner's case", () => {
  const from = { owner: "hynix666", repo: "ULTRA-TEMPLATE", name: "ultra-template" };
  const to = { owner: "Acme-Corp", repo: "My.Service", name: "my-service" };
  const text = '"name": "@hynix666/ultra-template" import "@hynix666/ultra-template" github.com/hynix666/ULTRA-TEMPLATE * @hynix666';
  assert.equal(
    replaceIdentity(text, from, to),
    '"name": "@acme-corp/my-service" import "@acme-corp/my-service" github.com/Acme-Corp/My.Service * @Acme-Corp',
  );
});

test("identity placeholders cannot collide with ordinary text such as a digest", () => {
  const from = { owner: "hynix666", repo: "ULTRA-TEMPLATE", name: "ultra-template" };
  const to = { owner: "octo", repo: "demo-app", name: "demo-app" };
  const text = "FROM node@sha256:00000000000000001230000 # hynix666";
  assert.equal(replaceIdentity(text, from, to), "FROM node@sha256:00000000000000001230000 # octo");
});

test("selection takes exactly one of preset or features and rejects unknown names", () => {
  const manifest = loadManifest();
  assert.deepEqual([...resolveSelection(manifest, { features: "web, release" })], ["web", "release"]);
  assert.equal(resolveSelection(manifest, { preset: "minimal" }).size, 0);
  assert.throws(() => resolveSelection(manifest, {}), /exactly one/);
  assert.throws(() => resolveSelection(manifest, { preset: "all", features: "web" }), /exactly one/);
  assert.throws(() => resolveSelection(manifest, { features: "web,kubernetes" }), /Unknown feature\(s\): kubernetes/);
});

test("the default description names the product features, and says so when there are none", () => {
  const manifest = loadManifest();
  assert.equal(describeProject(manifest, new Set(["ts-service"])), "Starts as a TypeScript task API.");
  assert.equal(describeProject(manifest, new Set(["ts-service", "web", "architecture", "release"])), "Starts as a TypeScript task API and a React web app.");
  assert.equal(
    describeProject(manifest, new Set(["go-service", "py-service", "ts-library"])),
    "Starts as a Go task API, a Python task API and a TypeScript library for npm.",
  );
  // Tooling features describe how the project is built, not what it is.
  assert.match(describeProject(manifest, new Set(["architecture", "release", "devcontainer"])), /^No application code yet/);
  assert.match(describeProject(manifest, new Set()), /^No application code yet/);
});

test("a given description is one line of prose, and lands at the README anchor with no note", () => {
  assert.equal(validateDescription("  Tracks work for the support team.  "), "Tracks work for the support team.");
  for (const bad of ["", "   ", "two\nlines", "x".repeat(301), "hidden <!-- note -->"]) {
    assert.throws(() => validateDescription(bad), InitError, JSON.stringify(bad));
  }
  const readme = `# app\n\n[![verify](x)](y)\n\n${DESCRIPTION_ANCHOR}\n\n## Getting started\n`;
  assert.equal(recordDescription(readme, "Tracks work.", false), "# app\n\n[![verify](x)](y)\n\nTracks work.\n\n## Getting started\n");
  assert.match(recordDescription(readme, "Starts as a web app.", true), /\n<!-- Written by init[^\n]*-->\nStarts as a web app\.\n/);
  assert.throws(() => recordDescription("# app\n", "Tracks work.", false), /no "<!-- project description -->" line/);
});

test("identity input is validated at the boundary", () => {
  assert.deepEqual(validateIdentity({ name: "my-app", owner: "my-org" }), { name: "my-app", owner: "my-org", repo: "my-app" });
  for (const bad of [{ name: "My App", owner: "o" }, { name: "../x", owner: "o" }, { name: "ok-name", owner: "bad/owner" }, { name: "ok-name" }]) {
    assert.throws(() => validateIdentity(bad), InitError, JSON.stringify(bad));
  }
});

test("a name derived from the repository blames the repository, and says how to name the project instead", () => {
  // "2025-report" becomes "2025-report", which cannot start a package name; the person never typed --name.
  assert.throws(
    () => validateIdentity({ name: toProjectName("2025-report"), owner: "my-org", repo: "2025-report" }, { nameFrom: "2025-report" }),
    (err) => err instanceof InitError && /the repository name "2025-report"/.test(err.message) && /pass --name/.test(err.message) && !/^--name must/.test(err.message),
  );
});

test("the real manifest is consistent and every marker in the tree is well formed", () => {
  const manifest = loadManifest();
  assert.deepEqual(validateManifest(manifest, (p) => existsSync(join(ROOT, p))), []);
  const ids = new Set(Object.keys(manifest.features));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  let markers = 0;
  for (const file of tracked.filter((f) => !f.startsWith("template/") && existsSync(join(ROOT, f)))) {
    const text = readFileSync(join(ROOT, file), "utf8");
    markers += text.split("\n").filter((l) => MARKER_RE.test(l)).length;
    assert.doesNotThrow(() => applyMarkers(text, ids, ids, file));
  }
  assert.ok(markers > 0, "expected marker lines in the tree");
});

test("a path may belong to several features, but not to one inside another's or the template's", () => {
  const manifest = (features, templateOnly = []) => ({ version: "1.0.0", features, templateOnly, presets: {} });
  const exists = () => true;
  // The same path under two features is how a file both of them need is expressed.
  assert.deepEqual(validateManifest(manifest({ a: { paths: ["svc"] }, b: { paths: ["svc"] } }), exists), []);
  assert.match(validateManifest(manifest({ a: { paths: ["svc"] }, b: { paths: ["svc/x.md"] } }), exists).join("\n"), /"svc\/x\.md" is inside "svc", which "a" owns/);
  assert.match(validateManifest(manifest({ a: { paths: ["template/x"] } }, ["template"]), exists).join("\n"), /"template\/x" is owned by "a" and is template-only/);
  assert.deepEqual(validateManifest(manifest({ a: { paths: ["svc"] }, b: { paths: ["svc2"] } }), exists), []);
});

test("template-test generates every preset features.json defines, from features.json itself", () => {
  // A list of presets written into the workflow is one a new preset would be missing from.
  const workflow = readFileSync(join(ROOT, ".github/workflows/template-test.yml"), "utf8");
  assert.doesNotMatch(workflow, /^\s*preset: \[/m, "the matrix lists presets of its own");
  assert.match(workflow, /preset: \$\{\{ fromJSON\(needs\.presets\.outputs\.presets\) \}\}/);
  assert.match(workflow, /Object\.keys\(require\("\.\/template\/features\.json"\)\.presets\)/);
});

test("the preset workflow is called by verify and cannot be left outside its gate", () => {
  const verify = readFileSync(join(ROOT, ".github/workflows/verify.yml"), "utf8");
  const presets = readFileSync(join(ROOT, ".github/workflows/template-test.yml"), "utf8");
  assert.match(verify, /^  template-presets:\n    uses: \.\/\.github\/workflows\/template-test\.yml$/m);
  assert.match(presets, /^  workflow_call:/m);
  assert.doesNotMatch(presets, /^  pull_request:/m, "the caller owns PR runs; do not duplicate the matrix");
  assert.deepEqual(checkGate("verify.yml", verify), []);
  assert.match(checkGate("verify.yml", verify.replace(/^      - template-presets\n/m, "")).join("\n"), /template-presets.*missing/);
});

test("the public contract only grows: no feature or preset of 1.x or 2.x is removed or renamed", () => {
  // Feature ids and preset names are what adopters type, and what template-update replays from a
  // project's CHANGELOG. Taking one away breaks every project that used it, which is a major version.
  // 2.0.0 was major for the storage port and kept every one of them; a major that drops one moves this line.
  const manifest = loadManifest();
  if (Number(manifest.version.split(".")[0]) > 2) return;
  const features = ["go-service", "ts-service", "py-service", "mcp-server", "web", "ts-library", "architecture", "release", "devcontainer"];
  const presets = ["minimal", "go-api", "py-api", "fullstack-ts", "library", "mcp", "all"];
  assert.deepEqual(features.filter((id) => !(id in manifest.features)), [], "features removed within 1.x or 2.x");
  assert.deepEqual(presets.filter((id) => !(id in manifest.presets)), [], "presets removed within 1.x or 2.x");
  for (const preset of presets.filter((id) => id !== "all")) {
    for (const feature of manifest.presets[preset]) assert.ok(manifest.presets.all.includes(feature), `${preset}: ${feature} is not in all`);
  }
});

test("every module's directory is owned by exactly one feature, the one its module.json names", () => {
  const manifest = loadManifest();
  const modules = presentModules();
  assert.ok(modules.length > 0, "no module.json found: discovery is broken");
  for (const module of modules) {
    const owners = Object.entries(manifest.features).filter(([, f]) => f.paths.includes(module.dir)).map(([id]) => id);
    assert.deepEqual(owners, [module.id], module.dir);
  }
});

test("removed paths cover unselected features and template-only files", () => {
  const removed = removedPaths(loadManifest(), new Set(["ts-library"]));
  assert.ok(removed.includes("template") && removed.includes("services/api-go"));
  assert.ok(!removed.includes("packages/ts-library"));
  // A path several features own goes only when none of its owners is selected.
  assert.ok(removed.includes("scripts/contract"), "nothing that serves or calls the task API is selected");
  assert.ok(!removedPaths(loadManifest(), new Set(["py-service"])).includes("scripts/contract"), "one owner selected");
  assert.ok(!removedPaths(loadManifest(), new Set(["web"])).includes("scripts/contract"), "a client of the API keeps the contract its facts are held to");
});

test("in-place init removes an unselected module whole, ignored files included", (t) => {
  const copy = mkdtempSync(join(tmpdir(), "init-inplace-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of tracked.filter((f) => existsSync(join(ROOT, f)))) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(copy, file));
  }
  const git = (...args) => execFileSync("git", args, { cwd: copy, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "copy");
  // What the Dev Container's postCreateCommand leaves behind before init runs.
  mkdirSync(join(copy, "services/api-ts/node_modules/pkg"), { recursive: true });
  writeFileSync(join(copy, "services/api-ts/node_modules/pkg/index.js"), "");

  execFileSync("node", ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--preset", "go-api"], { cwd: copy, stdio: "pipe" });

  assert.equal(existsSync(join(copy, "services/api-ts")), false);
  assert.equal(existsSync(join(copy, "template")), false);
  assert.equal(existsSync(join(copy, "services/api-go/go.mod")), true);
});

test("without --name, the project name comes from the repository being initialized", (t) => {
  const out = join(mkdtempSync(join(tmpdir(), "init-")), "never-written");
  t.after(() => rmSync(dirname(out), { recursive: true, force: true }));
  const plan = execFileSync(
    "node",
    ["template/init.mjs", "--source", source, "--owner", "octo", "--repo", "My.Service", "--preset", "minimal", "--out", out, "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(plan, /^my-service \(octo\/My\.Service\)/m);
});

test("every preset generates a project that passes its own chassis checks and documents only what it has", (t) => {
  const manifest = loadManifest();
  const base = mkdtempSync(join(tmpdir(), "presets-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const [preset, selected] of Object.entries(manifest.presets)) {
    const out = join(base, preset);
    execFileSync("node", ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--preset", preset, "--out", out], { cwd: ROOT, stdio: "pipe" });
    execFileSync("git", ["init", "-q"], { cwd: out });
    execFileSync("git", ["add", "-A"], { cwd: out });
    for (const check of ["scripts/check-hygiene.mjs", "scripts/check-docs.mjs"]) {
      assert.doesNotThrow(() => execFileSync("node", [check], { cwd: out, stdio: "pipe" }), `${preset}: ${check}`);
    }
    const readme = readFileSync(join(out, "README.md"), "utf8");
    assert.doesNotMatch(readFileSync(join(out, ".github/workflows/verify.yml"), "utf8"), /template-presets|template-release-check|template-test\.yml/);
    assert.ok(!readme.includes(DESCRIPTION_ANCHOR), `${preset}: README keeps the description anchor`);
    assert.ok(readme.includes(`\n${describeProject(manifest, new Set(selected))}\n`), `${preset}: README has no description`);
    // What this project does not have. A path several features own goes only when none of its owners
    // is selected, so an unselected feature's path may still be here because another one keeps it.
    const absent = [...new Set(Object.values(manifest.features).flatMap((feature) => feature.paths))]
      .filter((path) => !Object.entries(manifest.features).some(([id, f]) => selected.includes(id) && f.paths.includes(path)));
    for (const path of absent) {
      assert.ok(!readme.includes(`](${path}`) && !readme.includes(`\`${path}`), `${preset}: README still points at ${path}`);
    }
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: out, encoding: "utf8" }).split("\0").filter(Boolean);
    // A guide that names a module this project does not have sends its reader — or an agent following
    // it step by step — to a directory that is not there. A path is looked for only where it cannot be
    // mistaken for prose: `architecture` is a word, `apps/web` is not, and the last segment counts only
    // under services/ and .claude/skills/. ADRs are not guides: a decision record names what it decided.
    const guides = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "docs/README.md", ...tracked.filter((f) => f.startsWith(".claude/skills/"))];
    for (const file of guides.filter((f) => existsSync(join(out, f)))) {
      const text = readFileSync(join(out, file), "utf8");
      for (const path of absent) {
        if (/[/.]/.test(path)) assert.ok(!text.includes(path), `${preset}: ${file} names ${path}, which this project does not have`);
        const leaf = path.split("/").at(-1);
        if (!/^(services|\.claude\/skills)\//.test(path)) continue;
        assert.ok(!text.includes(leaf), `${preset}: ${file} names ${leaf}, which this project does not have`);
      }
    }
    // Nothing a project keeps may send its reader to a file only the template has.
    for (const file of tracked) {
      const text = readFileSync(join(out, file), "utf8");
      for (const only of ["template-test.yml", "template-release.yml", "template/README.md"]) {
        assert.ok(!text.includes(only), `${preset}: ${file} mentions ${only}, which the project does not have`);
      }
    }
  }
});

test("every feature on its own generates a project that passes its chassis checks", (t) => {
  // Presets are combinations. A feature selected alone is what --features allows, and what ADR-0004
  // claims when it calls modules independent and removable; nothing else proves one stands without
  // the others. check-hygiene also fails on a marker line that survived, once template/ is gone.
  const manifest = loadManifest();
  const base = mkdtempSync(join(tmpdir(), "features-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const id of Object.keys(manifest.features)) {
    const out = join(base, id);
    execFileSync("node", ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--features", id, "--out", out], { cwd: ROOT, stdio: "pipe" });
    execFileSync("git", ["init", "-q"], { cwd: out });
    execFileSync("git", ["add", "-A"], { cwd: out });
    for (const check of ["scripts/check-hygiene.mjs", "scripts/check-docs.mjs"]) {
      assert.doesNotThrow(() => execFileSync("node", [check], { cwd: out, stdio: "pipe" }), `${id}: ${check}`);
    }
    assert.equal(existsSync(join(out, "template")), false, `${id}: template/ survived`);
  }
});

test("--description is written under the README title, in place of the generated sentence", (t) => {
  const out = mkdtempSync(join(tmpdir(), "init-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  rmSync(out, { recursive: true });
  const args = ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--preset", "minimal", "--description", "Tracks work for the support team.", "--out", out];
  execFileSync("node", args, { cwd: ROOT, stdio: "pipe" });
  const readme = readFileSync(join(out, "README.md"), "utf8");
  assert.match(readme, /^# demo-app\n\n\[!\[verify\][^\n]*\n\nTracks work for the support team\.\n/);
  assert.doesNotMatch(readme, /Written by init|No application code yet/);
});

test("prose about the template still names the template after init, not the new project", (t) => {
  // Identity replacement rewrites the template's repository name everywhere, so a sentence such as
  // "generated from <template>" would come out naming the project itself. Outside a URL, the new
  // repository's name belongs only in the README title.
  const out = join(mkdtempSync(join(tmpdir(), "init-")), "project");
  t.after(() => rmSync(dirname(out), { recursive: true, force: true }));
  execFileSync("node", ["template/init.mjs", "--source", source, "--name", "zz-name", "--owner", "zz-owner", "--repo", "Zz.Repo", "--preset", "all", "--out", out], { cwd: ROOT, stdio: "pipe" });
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((f) => f && existsSync(join(out, f)));
  const stray = [];
  for (const file of tracked) {
    readFileSync(join(out, file), "utf8").split("\n").forEach((line, i) => {
      const bare = line.replaceAll("github.com/zz-owner/Zz.Repo", "");
      if (bare.includes("Zz.Repo") && !(file === "README.md" && line === "# Zz.Repo")) stray.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(stray, []);
  // Where each identity value lands, as the public contract states it: the repository titles the
  // README and carries the links, the name is the package and its scope.
  assert.match(readFileSync(join(out, "README.md"), "utf8"), /^# Zz.Repo$/m);
  assert.equal(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).name, "zz-name");
  assert.equal(JSON.parse(readFileSync(join(out, "packages/ts-library/package.json"), "utf8")).name, "@zz-owner/zz-name");
});

test("the licence names the year the project is created", () => {
  const manifest = loadManifest();
  const identity = { name: "demo-app", owner: "octo", repo: "demo-app" };
  const license = plan(ROOT, manifest, new Set(), identity, undefined, 2031).files.find((f) => f.file === "LICENSE");
  assert.match(license.data, /^Copyright \(c\) 2031 octo$/m);
});

test("init --out writes a project with no template residue", (t) => {
  const out = mkdtempSync(join(tmpdir(), "init-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  rmSync(out, { recursive: true });
  execFileSync("node", ["template/init.mjs", "--source", source, "--name", "demo-app", "--owner", "octo", "--preset", "minimal", "--out", out], { cwd: ROOT, stdio: "pipe" });
  for (const gone of ["template", "services", "apps", "architecture", ".devcontainer", ".github/workflows/template-test.yml"]) {
    assert.equal(existsSync(join(out, gone)), false, gone);
  }
  // A new project's copyright starts the year it is created, not the year the template was written.
  assert.match(readFileSync(join(out, "LICENSE"), "utf8"), new RegExp(`^Copyright \\(c\\) ${new Date().getUTCFullYear()} octo$`, "m"));
  const { version } = loadManifest();
  assert.match(
    readFileSync(join(out, "CHANGELOG.md"), "utf8"),
    new RegExp(`- Initialized from \\[ULTRA-TEMPLATE v${version.replaceAll(".", "\\.")}\\]\\(https://github\\.com/Ultra-Solo/ULTRA-TEMPLATE/releases/tag/v${version.replaceAll(".", "\\.")}\\) with no features\\.`),
  );
  assert.match(readFileSync(join(out, "README.md"), "utf8"), /^# demo-app/);
  assert.doesNotMatch(readFileSync(join(out, ".github/workflows/verify.yml"), "utf8"), /ultra:|go-service/);
});
