// The Node version check must be seen to fail, and to pass on what CI would run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeVersionProblem } from "../scripts/modules.mjs";

test("the running Node matches .node-version by major version", () => {
  assert.equal(nodeVersionProblem("24\n", "24.21.0"), null);
  assert.equal(nodeVersionProblem("v24.1.0", "24.21.0"), null);
  assert.equal(nodeVersionProblem("24", "v24.0.0"), null);
});

test("another major is refused, with the fix in the message", () => {
  assert.match(nodeVersionProblem("24", "22.22.2") ?? "", /this is Node 22\.22\.2, but \.node-version pins Node 24, which CI runs\. Switch to Node 24/);
  assert.match(nodeVersionProblem("24", "240.0.0") ?? "", /pins Node 24/);
});

test("a .node-version that names no version is refused rather than read as any", () => {
  assert.match(nodeVersionProblem("lts/*", "24.21.0") ?? "", /names no Node major version/);
  assert.match(nodeVersionProblem("", "24.21.0") ?? "", /names no Node major version/);
});

test("modules are found by their manifests, below dependencies and the template never", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadModules } = await import("../scripts/modules.mjs");
  const root = mkdtempSync(join(tmpdir(), "modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, body) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body));
  };
  const manifest = (id) => ({ id, toolchain: "node", checks: [{ name: "npm run verify", run: ["npm", "run", "verify"] }] });
  put("services/api/module.json", manifest("api"));
  put("tool/module.json", manifest("tool"));
  put("apps/web/node_modules/pkg/module.json", manifest("dependency"));
  put("template/module.json", manifest("template-only"));
  put("broken/module.json", "{ not json");

  const { modules, problems } = loadModules(root);
  assert.deepEqual(modules.map((m) => `${m.id} ${m.dir}`), ["api services/api", "tool tool"]);
  assert.match(problems.join(), /broken\/module\.json is not valid JSON/);
});

test("a manifest's check says exactly when it may be skipped", async () => {
  const { validateManifest } = await import("../scripts/modules.mjs");
  const base = { id: "m", toolchain: "go" };
  const problems = (check) => validateManifest({ ...base, checks: [check] }, "m/module.json").join();
  assert.equal(problems({ name: "vet", run: ["go", "vet", "./..."] }), "");
  assert.match(problems({ name: "t", run: ["go", "test"], requires: "moonlight" }), /requires must be one of cgo/);
  assert.match(problems({ name: "t", run: ["go", "test"], otherwise: { name: "x", run: ["go", "test"] } }), /otherwise needs `requires`/);
  assert.match(problems({ name: "lint", run: ["golangci-lint", "run"], tool: "staticcheck" }), /tool must name the command the check runs/);
  assert.match(problems({ name: "fmt", run: ["gofmt", "-l", "."], expect: "silence" }), /expect can only be "no-output"/);
});

test("verify runs each module's checks from its manifest, and nothing else", async () => {
  const { execFileSync } = await import("node:child_process");
  const { ROOT, presentModules } = await import("../scripts/modules.mjs");
  const lines = execFileSync(process.execPath, ["scripts/verify.mjs", "--dry-run", "--no-chassis"], { cwd: ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  for (const module of presentModules()) {
    const planned = lines.filter(([name]) => name.startsWith(`${module.id}: `));
    const own = planned.filter(([, dir]) => dir === module.dir).map(([, , command]) => command);
    assert.deepEqual(own, module.checks.map((c) => c.run.join(" ")), module.id);
  }
});

test("a module's end-to-end check names the task API it runs against, and runs against a service on its own toolchain first", async () => {
  const { e2ePartner, validateManifest } = await import("../scripts/modules.mjs");
  const base = { id: "client", toolchain: "node", checks: [{ name: "t", run: ["npm", "test"] }] };
  assert.deepEqual(validateManifest({ ...base, e2e: { run: ["npm", "run", "e2e", "--", "{taskApi}"] } }), []);
  assert.match(validateManifest({ ...base, e2e: { run: ["npm", "run", "e2e"] } }).join(), /must pass the task API's address as \{taskApi\}/);
  assert.match(validateManifest({ ...base, e2e: { run: ["x", "{taskApi}"], when: "always" } }).join(), /`e2e` is \{"run": command\}/);
  const go = { id: "go", toolchain: "go", taskApi: { run: ["api"] } };
  const ts = { id: "ts", toolchain: "node", taskApi: { run: ["node", "main.ts"] } };
  assert.equal(e2ePartner(base, [go, ts, base])?.id, "ts");
  assert.equal(e2ePartner(base, [go, base])?.id, "go");
  assert.equal(e2ePartner(base, [base]), null);
});

test("verify runs a client's end-to-end check when a task service is present", async () => {
  const { execFileSync } = await import("node:child_process");
  const { ROOT, e2ePartner, presentModules } = await import("../scripts/modules.mjs");
  const plan = execFileSync(process.execPath, ["scripts/verify.mjs", "--dry-run", "--no-chassis"], { cwd: ROOT, encoding: "utf8" });
  const present = presentModules();
  for (const module of present.filter((m) => m.e2e)) {
    const partner = e2ePartner(module, present);
    const step = `${module.id}: end to end with ${partner?.id}\t.\tnode scripts/check-contract.mjs --e2e ${module.id} --service ${partner?.id}`;
    assert.equal(plan.includes(step), partner !== null, module.id);
  }
});

test("the tools this checkout installs come first on PATH for everything verify and setup start", async () => {
  const { delimiter } = await import("node:path");
  const { withToolsBin } = await import("../scripts/modules.mjs");
  const bin = "/repo/.tools/bin";
  assert.equal(withToolsBin(`/usr/bin${delimiter}/bin`, bin, () => true), `${bin}${delimiter}/usr/bin${delimiter}/bin`);
  assert.equal(withToolsBin("/usr/bin", bin, () => false), "/usr/bin", "nothing installed, nothing added");
  assert.equal(withToolsBin(`${bin}${delimiter}/usr/bin`, bin, () => true), `${bin}${delimiter}/usr/bin`, "already first");
  assert.equal(withToolsBin(`/usr/bin${delimiter}${bin}`, bin, () => true), `${bin}${delimiter}/usr/bin`, "moved first, not listed twice");
  assert.equal(withToolsBin(undefined, bin, () => true), bin);
});

test("a declared skip is a failure in GitHub Actions, where the module's job has what it needs", async () => {
  const { skipOutcome } = await import("../scripts/modules.mjs");
  assert.equal(skipOutcome({}), "skipped");
  assert.equal(skipOutcome({ GITHUB_ACTIONS: "true" }), "fail");
});

test("an image is probed through the contract or by the module's own command, which names the image", async () => {
  const { validateManifest } = await import("../scripts/modules.mjs");
  const base = { id: "m", toolchain: "node", checks: [{ name: "t", run: ["npm", "test"] }] };
  assert.deepEqual(validateManifest({ ...base, taskApi: { run: ["node", "main.ts"] }, image: "http" }), []);
  assert.match(validateManifest({ ...base, image: "http" }).join(), /probes the task API, which needs `taskApi`/);
  assert.deepEqual(validateManifest({ ...base, image: { run: ["npm", "run", "probe", "--", "{image}"] } }), []);
  assert.match(validateManifest({ ...base, image: { run: ["npm", "run", "probe"] } }).join(), /must name the image it probes as \{image\}/);
  assert.match(validateManifest({ ...base, image: "mcp" }).join(), /`image` must be one of http, or \{"run": command\}/);
});

test("a module's CI job sets up and installs what its checks and its end-to-end partner need", async () => {
  const { jobNeeds } = await import("../scripts/modules.mjs");
  const go = { id: "go", dir: "svc/go", toolchain: "go", checks: [], taskApi: { run: ["api"] }, image: "http", coverage: { run: [], report: "c" } };
  const ts = { id: "ts", dir: "svc/ts", toolchain: "node", checks: [], taskApi: { run: ["node"] } };
  const client = { id: "client", dir: "svc/client", toolchain: "node", checks: [], e2e: { run: ["x", "{taskApi}"] } };
  const needs = (module, modules) => Object.fromEntries(jobNeeds(module, modules).map((line) => line.split("=")));
  assert.deepEqual(needs(go, [go, ts, client]), { node: "false", go: "true", python: "false", "go-version-file": "svc/go/go.mod", toolchains: "go", modules: "go", dir: "svc/go", audit: "false", coverage: "true", image: "true" });
  assert.equal(needs(client, [go, ts, client]).modules, "client ts", "a partner on its own toolchain first");
  assert.equal(needs(client, [go, client]).toolchains, "node,go", "and the partner's toolchain when it is another");
  assert.equal(needs(client, [client]).modules, "client");
});

test("verify holds a module check's pinned tool to its pin, running the check only at that version", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { delimiter, join } = await import("node:path");
  const { ROOT } = await import("../scripts/modules.mjs");
  if (process.platform === "win32") return t.skip("the fake tool is a shell script");
  const dir = mkdtempSync(join(tmpdir(), "verify-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts/tools/tools.json"), JSON.stringify({ tools: { faketool: { version: "1.0.0", for: "node", versionCommand: ["faketool", "--version"] } } }));
  mkdirSync(join(dir, "mod/node_modules"), { recursive: true });
  writeFileSync(join(dir, "mod/module.json"), JSON.stringify({ id: "mod", toolchain: "node", checks: [{ name: "fake", run: ["faketool", "run"], tool: "faketool" }] }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const verify = (version) => {
    writeFileSync(join(bin, "faketool"), `#!/bin/sh\n[ "$1" = --version ] && echo faketool ${version}\nexit 0\n`);
    chmodSync(join(bin, "faketool"), 0o755);
    return spawnSync(process.execPath, ["scripts/verify.mjs", "--no-chassis"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "", PATH: [bin, ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) },
    });
  };
  const pinned = verify("1.0.0");
  assert.equal(pinned.status, 0, pinned.stderr + pinned.stdout);
  assert.match(pinned.stdout, /✔ mod: fake/);
  const other = verify("0.9.0");
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stdout, /✘ mod: fake {2}\(faketool 0\.9\.0 is on PATH, but scripts\/tools\/tools\.json pins 1\.0\.0/);
});
