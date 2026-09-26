// Every rule gets a case that must fire and the clean fixture that must not. A checker with only
// the passing case proves nothing: it passes just as well when the rule is broken.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  checkCalledPermissions,
  checkDigests,
  checkDownloads,
  checkGate,
  checkModules,
  checkPins,
  checkRepoHygiene,
  checkVersions,
  checkWorkflow,
  jobIds,
  leadingVersion,
  MAX_TRACKED_BYTES,
  parseJsonc,
  REQUIRED_IGNORES,
  satisfies,
  specifierFloor,
  tomlString,
} from "../scripts/check-hygiene.mjs";

const IGNORE = [...REQUIRED_IGNORES, "!.env.example", "build/", "*.tsbuildinfo", ".DS_Store", ".idea/", "*.local"].join("\n");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({ ".gitignore": `${IGNORE}\n`, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
  return root;
}

const failures = (root) => checkRepoHygiene(root).failures.join("\n");

test("a clean repository passes", (t) => {
  const result = checkRepoHygiene(fixture(t, { "README.md": "# ok\n", "package.json": "{}\n", ".env.example": "PORT=8080\n" }));
  assert.equal(result.ok, true, result.failures?.join("\n"));
});

test("a truncated .gitignore fails", (t) => {
  assert.match(failures(fixture(t, { ".gitignore": "node_modules/\n" })), /below the floor/);
});

test("a dependency directory tracked below the root fails", (t) => {
  assert.match(failures(fixture(t, { "apps/web/node_modules/pkg/index.js": "" })), /under a `node_modules` directory/);
});

test("a build cache tracked anywhere fails, whatever produced it", (t) => {
  // Committed once by a Python module whose .gitignore had no rules for it; a rule, not an incident.
  assert.match(failures(fixture(t, { "services/api-py/src/__pycache__/x.pyc": "" })), /under a `__pycache__` directory/);
  assert.match(failures(fixture(t, { ".pytest_cache/v/cache/lastfailed": "{}" })), /under a `.pytest_cache` directory/);
});

test("an oversized file fails", (t) => {
  assert.match(failures(fixture(t, { "blob.bin": Buffer.alloc(MAX_TRACKED_BYTES + 1) })), /blob\.bin` is 4\.0 MB/);
});

test("invalid JSON fails while tsconfig comments pass", (t) => {
  const found = failures(fixture(t, { "broken.json": "{", "tsconfig.json": "{ // comments are fine here\n}\n" }));
  assert.match(found, /broken\.json` is not valid JSON/);
  assert.doesNotMatch(found, /tsconfig/);
});

test("a tracked .env fails and .env.example does not", (t) => {
  const found = failures(fixture(t, { ".env": "TOKEN=x\n", ".env.example": "TOKEN=\n" }));
  assert.match(found, /environment file\(s\) tracked: \.env\./);
  assert.doesNotMatch(found, /tracked: .*\.env\.example/);
});

test("a template marker fails after initialization but not while template/ exists", (t) => {
  const marker = `# ultra:${"begin"} web\n`;
  assert.match(failures(fixture(t, { "ci.yml": marker })), /survived initialization: ci\.yml:1/);
  assert.equal(checkRepoHygiene(fixture(t, { "ci.yml": marker, "template/features.json": "{}\n" })).ok, true);
});

test("workflow rules fire on an unpinned action, missing permissions and a missing timeout", () => {
  const found = checkWorkflow(".github/workflows/ci.yml", "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n").join("\n");
  assert.match(found, /not pinned/);
  assert.match(found, /no top-level `permissions:`/);
  assert.match(found, /job `build` has no `timeout-minutes`/);
});

test("a pinned workflow with permissions and timeouts passes, and a reusable call needs no timeout", () => {
  const text = [
    "on: push", "permissions:", "  contents: read", "jobs:",
    "  build:", "    runs-on: ubuntu-latest", "    timeout-minutes: 5", "    steps:",
    `      - uses: actions/checkout@${SHA} # v7.0.1`, "      - uses: ./.github/actions/local",
    "  deploy:", "    uses: ./.github/workflows/deploy.yml",
  ].join("\n");
  assert.deepEqual(checkWorkflow(".github/workflows/ci.yml", text), []);
});

test("a step that starts a detached container must remove it with a trap first", () => {
  const step = (...run) => ["jobs:", "  api:", "    steps:", "      - name: Container answers", "        run: |", ...run.map((l) => `          ${l}`)].join("\n");
  const start = "docker run --detach --name api --publish 8080:8080 api:ci";
  assert.match(checkWorkflow(".github/workflows/ci.yml", step(start)).join(""), /container `api` detached with no `trap/);
  // A trap in an earlier step does not cover this one, and a trap for another container does not either.
  const elsewhere = ["jobs:", "  api:", "    steps:", "      - run: trap 'docker rm --force api' EXIT", "      - run: |", `          ${start}`].join("\n");
  assert.match(checkWorkflow(".github/workflows/ci.yml", elsewhere).join(""), /container `api`/);
  assert.match(checkWorkflow(".github/workflows/ci.yml", step("trap 'docker rm --force web' EXIT", start)).join(""), /container `api`/);
  const clean = (l) => !/container/.test(l);
  assert.ok(checkWorkflow(".github/workflows/ci.yml", step("trap 'docker rm --force api > /dev/null 2>&1 || true' EXIT", start)).every(clean));
  assert.ok(checkWorkflow(".github/workflows/ci.yml", step("docker run --rm -i api:ci")).every(clean));
});

test("an npm install without --ignore-scripts fails in a workflow and a Dockerfile; a comment does not", (t) => {
  const workflow = (run) => ["jobs:", "  web:", "    steps:", `      - run: ${run}`, "      # npm ci runs here, as the comment says"].join("\n");
  assert.match(checkWorkflow(".github/workflows/ci.yml", workflow("npm ci")).join(""), /ci\.yml:4 installs with npm without --ignore-scripts/);
  assert.match(checkWorkflow(".github/workflows/ci.yml", workflow("npm install --save-dev x")).join(""), /without --ignore-scripts/);
  assert.doesNotMatch(checkWorkflow(".github/workflows/ci.yml", workflow("npm ci --ignore-scripts")).join(""), /ignore-scripts/);
  assert.doesNotMatch(checkWorkflow(".github/workflows/ci.yml", workflow("npm run build")).join(""), /ignore-scripts/);
  const found = failures(fixture(t, {
    "services/api/Dockerfile": `FROM node:24@sha256:${"a".repeat(64)}\nRUN npm ci --omit=dev\n`,
    "services/ok/Dockerfile": `FROM node:24@sha256:${"a".repeat(64)}\nRUN npm ci --omit=dev --ignore-scripts\n`,
  }));
  assert.match(found, /services\/api\/Dockerfile:2 installs with npm without --ignore-scripts/);
  assert.doesNotMatch(found, /services\/ok\/Dockerfile/);
});

test("a verify.yml job missing from the gate's needs fails", () => {
  const workflow = (needs) => [
    "permissions:", "  contents: read", "jobs:",
    "  lint:", "    timeout-minutes: 5", "  test:", "    timeout-minutes: 5",
    "  verify:", "    needs:", ...needs.map((n) => `      - ${n}`), "      # a comment line is not a job", "    timeout-minutes: 5",
  ].join("\n");
  assert.match(checkGate("verify.yml", workflow(["lint"])).join(""), /job\(s\) test are missing/);
  assert.deepEqual(checkGate("verify.yml", workflow(["lint", "test"])), []);
  assert.match(checkGate("verify.yml", "jobs:\n  lint:\n    timeout-minutes: 5\n").join(""), /no aggregate `verify` job/);
});

// The shape release.yml and mcp-publish.yml had through v1.2.0: GitHub refused to start every run.
const CALLED = `on:
  workflow_call:
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo release
  image:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      packages: write
    steps:
      - run: echo image
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    steps:
      - run: echo publish
`;
const caller = (grant, top = "permissions:\n  contents: read\n") => `on:
  push:
${top}jobs:
  publish-mcp-server:
${grant}    uses: ./.github/workflows/mcp-publish.yml
`;
const grant = (...scopes) => `    permissions:\n${scopes.map((s) => `      ${s}\n`).join("")}`;
const calls = (callerText, calledText = CALLED) =>
  checkCalledPermissions({ ".github/workflows/release.yml": callerText, ".github/workflows/mcp-publish.yml": calledText }).join("\n");

test("rule 18: a call that grants less than a called job asks for fails, naming the scope", () => {
  const found = calls(caller(grant("contents: read", "packages: write", "id-token: write")));
  assert.match(found, /release\.yml:6 job `publish-mcp-server` calls \.github\/workflows\/mcp-publish\.yml, whose job `publish` asks for `attestations: write`, but the call grants `attestations: none`/);
  assert.doesNotMatch(found, /`image`|`release` asks/, "the jobs the grant covers are not named");
  assert.equal(calls(caller(grant("contents: read", "packages: write", "id-token: write", "attestations: write"))), "");
  assert.equal(calls(caller(grant("contents: write", "packages: write", "id-token: write", "attestations: write"))), "", "write satisfies read");
  assert.equal(calls(caller("    permissions: { contents: read, packages: write, id-token: write, attestations: write }\n")), "", "a flow map is read too");
});

test("rule 18: a caller job with no block grants its workflow's top level; a called job with none inherits", () => {
  const top = "permissions:\n  contents: read\n  packages: write\n  id-token: write\n  attestations: write\n";
  assert.equal(calls(caller("", top)), "");
  assert.match(calls(caller("", "permissions:\n  contents: read\n")), /whose job `image` asks for `packages: write`, but the call grants `packages: none`/);
  const inherits = "on:\n  workflow_call:\njobs:\n  only:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo\n";
  assert.equal(calls(caller("    permissions: {}\n"), inherits), "", "a called job with no block anywhere runs with what the call grants");
  const fromTop = "on:\n  workflow_call:\npermissions:\n  contents: read\njobs:\n  only:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo\n";
  assert.match(calls(caller("    permissions: {}\n"), fromTop), /whose job `only` asks for `contents: read`, but the call grants `contents: none`/);
});

test("rule 18: read-all and write-all are asked and granted as a whole; {} asks for nothing", () => {
  const readAll = "on:\n  workflow_call:\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions: read-all\n    steps:\n      - run: echo\n";
  assert.match(calls(caller(grant("contents: read")), readAll), /whose job `scan` asks for `read-all`, but the call grants only named scopes/);
  assert.equal(calls(caller("    permissions: write-all\n"), readAll), "");
  const nothing = readAll.replace("permissions: read-all", "permissions: {}");
  assert.equal(calls(caller("    permissions: {}\n"), nothing), "");
});

test("rule 18: a block it cannot read, or a call to a workflow that is not here, is reported", () => {
  assert.match(calls(caller("    permissions: ${{ inputs.scope }}\n")), /release\.yml:7 has a `permissions:` block this check cannot read/);
  assert.match(
    checkCalledPermissions({ ".github/workflows/release.yml": caller(grant("contents: read")) }).join("\n"),
    /job `publish-mcp-server` calls \.github\/workflows\/mcp-publish\.yml, which is not in the repository/,
  );
  assert.equal(checkCalledPermissions({ ".github/workflows/ci.yml": "on:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@0123\n" }).join(""), "", "a workflow in another repository is not ours to read");
});

test("rule 18 runs over the repository's workflows", (t) => {
  const root = fixture(t, {
    ".github/workflows/release.yml": caller(grant("contents: read", "packages: write", "id-token: write")),
    ".github/workflows/mcp-publish.yml": CALLED,
  });
  assert.match(failures(root), /asks for `attestations: write`, but the call grants `attestations: none`/);
});

test("a raw control character in a source file fails, and an escape does not", (t) => {
  const found = failures(fixture(t, { "src/raw.mjs": "const sep = \"\u0000\";\n", "src/escaped.mjs": "const sep = \"\\u0000\";\n" }));
  assert.match(found, /raw control character\(s\) in src\/raw\.mjs:1\./);
  assert.doesNotMatch(found, /escaped\.mjs/);
});

test("an invisible or text-reordering character fails wherever it hides, and its escape does not", (t) => {
  const found = failures(fixture(t, {
    "AGENTS.md": "# Rules\n\nBe careful.\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\n",
    "src/trojan.mjs": "const role = \"user\u202E \u2066// admin\u2069 \u2066\";\n",
    "docs/zero.md": "pass\u200Bword\n",
    "src/escaped.mjs": "const zwsp = \"\\u200B\";\n",
    "biome.jsonc": "{ // lint\u202E\n}\n",
    "docs/plain.md": "Café, naïve, 日本語 and ✓ are ordinary text.\n",
    // Emoji spelt with a presentation selector, a keycap, a skin tone and joiners are ordinary text too.
    "docs/emoji.md": "\u26A0\uFE0F Read first. Made with \u2764\uFE0F. Step 1\uFE0F\u20E3. \u{1F469}\u{1F3FD}\u200D\u{1F4BB} and \u{1F468}\u200D\u{1F469}\u200D\u{1F467} wrote it.\n",
    // A selector or joiner outside an emoji is not.
    "docs/stray-selector.md": "admin\uFE0F\n",
    "docs/stray-joiner.md": "pass\u200Dword\n",
  }));
  assert.match(found, /invisible or text-reordering character\(s\) in AGENTS\.md:3, biome\.jsonc:1, docs\/stray-joiner\.md:1, docs\/stray-selector\.md:1, docs\/zero\.md:1, src\/trojan\.mjs:1\./);
  assert.doesNotMatch(found, /escaped\.mjs|plain\.md|emoji\.md/);
});

test("an absolute path into a home directory fails; container paths, placeholders and URLs do not", (t) => {
  // Assembled at run time: written out whole, these paths would make this file fail the rule it tests.
  const users = "Us" + "ers";
  const found = failures(fixture(t, {
    "docs/mac.md": `Open /${users}/alice/project first.\n`,
    "docs/windows.md": `Run C:\\${users}\\bob\\tools\\x.exe\n`,
    "docs/forward.md": `cd C:/${users}/bob/src\n`,
    "docs/fine.md": "Clone to ~/src or /Users/<you>/src; see https://example.com/home/page and /usr/local/bin.\n",
    // /home/<name> inside a container is configuration, not anyone's machine.
    ".devcontainer/devcontainer.json": "{ \"remoteUser\": \"node\", \"mounts\": [\"source=cache,target=/home/node/.cache,type=volume\"] }\n",
    "compose.yml": "services:\n  app:\n    volumes: [\"./data:/home/app/data\"]\n",
  }));
  assert.match(found, /home directory in docs\/forward\.md:1, docs\/mac\.md:1, docs\/windows\.md:1\./);
  assert.doesNotMatch(found, /fine\.md|devcontainer\.json|compose\.yml/);
});

// A node module's manifest and package.json, as module.json and npm would write them.
const nodeModule = (id, scripts = { verify: "npm test" }, extra = {}) => ({
  manifest: JSON.stringify({ id, toolchain: "node", checks: [{ name: "npm run verify", run: ["npm", "run", "verify"] }], ...extra }),
  pkg: JSON.stringify({ scripts }),
});

test("a module missing its lockfile, or a script its manifest runs, fails; a complete one passes", () => {
  const api = nodeModule("ts-service");
  const web = nodeModule("web", { test: "vitest run" });
  const py = JSON.stringify({ id: "py-service", toolchain: "python", checks: [{ name: "pytest", run: ["uv", "run", "pytest"] }] });
  const files = {
    "services/api-ts/module.json": api.manifest,
    "services/api-ts/package.json": api.pkg,
    "apps/web/module.json": web.manifest,
    "apps/web/package.json": web.pkg,
    "services/api-py/module.json": py,
  };
  const read = (path) => files[path];

  const complete = ["services/api-ts/module.json", "services/api-ts/package.json", "services/api-ts/package-lock.json", "services/api-ts/src/main.ts"];
  assert.deepEqual(checkModules(complete, read), []);
  assert.match(checkModules(complete.filter((p) => !p.endsWith("lock.json")), read).join(), /api-ts` is present but does not track `package-lock\.json`/);
  assert.match(
    checkModules(["apps/web/module.json", "apps/web/package.json", "apps/web/package-lock.json"], read).join(),
    /apps\/web\/module\.json` runs `npm run verify`, which `apps\/web\/package\.json` does not define/,
  );
  assert.match(checkModules(["services/api-py/module.json", "services/api-py/pyproject.toml"], read).join(), /api-py` is present but does not track `uv\.lock`/);
  // A directory with no module in it is not a missing lockfile.
  assert.deepEqual(checkModules(["README.md"], read), []);
});

test("a malformed manifest, a repeated module name, and a module no manifest declares all fail", () => {
  const files = {
    "a/module.json": JSON.stringify({ id: "Bad Id", toolchain: "cobol", checks: [], colour: "red" }),
    "b/module.json": nodeModule("same").manifest,
    "b/package.json": nodeModule("same").pkg,
    "c/module.json": nodeModule("same").manifest,
    "c/package.json": nodeModule("same").pkg,
  };
  const read = (path) => files[path];
  const found = checkModules(Object.keys(files).concat(["b/package-lock.json", "c/package-lock.json", "tools/gen/go.mod", "package.json"]), read).join("\n");
  assert.match(found, /a\/module\.json: unknown key `colour`/);
  assert.match(found, /a\/module\.json: `id` must be lowercase/);
  assert.match(found, /a\/module\.json: `toolchain` must be one of/);
  assert.match(found, /a\/module\.json: `checks` must list at least one check/);
  assert.match(found, /`c\/module\.json` and `b\/module\.json` both name the module `same`/);
  assert.match(found, /`tools\/gen\/go\.mod` looks like a module, but no `module\.json` declares it/);
  // The repository's own package.json names scripts; it is no module.
  assert.doesNotMatch(found, /`package\.json` looks like a module/);
});

test("a module present without its CI job or its Dependabot entry fails; wiring read only when tracked", () => {
  const api = nodeModule("ts-service");
  const files = {
    "services/api-ts/module.json": api.manifest,
    "services/api-ts/package.json": api.pkg,
    ".github/workflows/verify.yml": "jobs:\n  chassis:\n    timeout-minutes: 5\n  ts-service:\n    timeout-minutes: 5\n",
    ".github/dependabot.yml": "updates:\n  - package-ecosystem: npm\n    directory: /services/api-ts\n",
  };
  const module = ["services/api-ts/module.json", "services/api-ts/package.json", "services/api-ts/package-lock.json"];
  const wiring = [".github/workflows/verify.yml", ".github/dependabot.yml"];
  const read = (overrides = {}) => (path) => ({ ...files, ...overrides })[path];

  assert.deepEqual(checkModules([...module, ...wiring], read()), []);
  const noJob = read({ ".github/workflows/verify.yml": "jobs:\n  chassis:\n    timeout-minutes: 5\n" });
  assert.match(checkModules([...module, ...wiring], noJob).join(), /`services\/api-ts` is present but `verify\.yml` has no `ts-service` job/);
  const noEntry = read({ ".github/dependabot.yml": "updates:\n  - package-ecosystem: npm\n    directory: /apps/web\n" });
  assert.match(checkModules([...module, ...wiring], noEntry).join(), /`\.github\/dependabot\.yml` has no entry for `\/services\/api-ts`/);
  // A directory that only starts the same is not the same directory.
  const prefix = read({ ".github/dependabot.yml": "updates:\n  - directory: /services/api-ts-old\n" });
  assert.match(checkModules([...module, ...wiring], prefix).join(), /no entry for `\/services\/api-ts`/);
  // Quoted, and listed under `directories:`, are the same entry.
  const listed = read({ ".github/dependabot.yml": "updates:\n  - directories:\n      - \"/services/api-ts\"\n" });
  assert.deepEqual(checkModules([...module, ...wiring], listed), []);
  // Deleting a wiring file is a decision; the rule does not read a file that is not tracked.
  const untouched = (path) => {
    if (path.startsWith(".github/")) throw new Error(`read ${path}, which is not tracked`);
    return files[path];
  };
  assert.deepEqual(checkModules(module, untouched), []);
});

test("jobIds lists the jobs of a two-space workflow and nothing nested below them", () => {
  const text = ["on: push", "jobs:", "  a:", "    steps:", "      - run: x", "  b-c:", "    needs:", "      - a", "other: 1", "  d:"].join("\n");
  assert.deepEqual(jobIds(text), ["a", "b-c"]);
  assert.deepEqual(jobIds("on: push\n"), []);
});

test("rule 14: a FROM without a digest fails; a digest, a platform flag and a stage alias pass", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const ok = [
    `FROM --platform=$BUILDPLATFORM golang:1.26-alpine@${digest} AS build`,
    "RUN go build",
    "FROM build AS test",
    `FROM gcr.io/distroless/static:nonroot@${digest}`,
    "FROM scratch",
    "COPY --from=build /out /",
  ].join("\n");
  assert.deepEqual(checkDigests("Dockerfile", ok), []);
  assert.match(checkDigests("svc/Dockerfile", "FROM node:24-alpine\n").join(), /svc\/Dockerfile:1 names base image `node:24-alpine` by tag alone/);
  assert.match(checkDigests("Dockerfile", "from node:24@sha256:abc\n").join(), /by tag alone/);
  assert.match(checkDigests("Dockerfile", "# FROM node:24\nFROM ${BASE}\n").join(), /Dockerfile:2 .*`\$\{BASE\}`/);
  assert.doesNotMatch(checkDigests("Dockerfile", "# FROM node:24\n").join(), /./);
});

test("rule 15: a download that keeps a file needs a checksum in the same step", () => {
  const step = (...run) => ["jobs:", "  a:", "    steps:", "      - name: Install", "        run: |", ...run.map((l) => `          ${l}`), "      - run: echo next"].join("\n");
  const sum = 'echo "$SHA  x.tgz" | sha256sum -c -';
  assert.match(checkDownloads("ci.yml", step("curl -fsSL -o x.tgz https://e.x/x.tgz")).join(), /ci\.yml:6 downloads a file with no checksum/);
  assert.deepEqual(checkDownloads("ci.yml", step("curl -fsSL -o x.tgz https://e.x/x.tgz", sum)), []);
  // A checksum before the download, or a continuation line, is still the same step.
  assert.deepEqual(checkDownloads("ci.yml", step("curl -fsSL --retry 3 \\", "  -o x.tgz https://e.x/x.tgz", "shasum -a 256 -c sums.txt")), []);
  // A checksum in the next step does not count.
  const next = ["jobs:", "  a:", "    steps:", "      - run: curl -fsSLO https://e.x/x.tgz", `      - run: ${sum}`].join("\n");
  assert.match(checkDownloads("ci.yml", next).join(), /ci\.yml:4 downloads/);
  // Every way of keeping a file counts.
  for (const line of ["curl -sSfLO https://e.x/x", "curl --output x https://e.x/x", "curl --output=x https://e.x/x", "curl https://e.x/x > x", "wget https://e.x/x", "wget -O x https://e.x/x", "curl https://e.x/x | tar -xz"]) {
    assert.match(checkDownloads("ci.yml", step(line)).join(), /no checksum/, line);
  }
  // A download that keeps nothing is not a download to verify.
  for (const line of ["curl --fail --silent --show-error localhost:8080/healthz", "curl -o /dev/null https://e.x", "curl -o - https://e.x | jq .", "wget -qO- https://e.x | jq .", "curl https://e.x 2> err.log", "curl https://e.x >&2"]) {
    assert.deepEqual(checkDownloads("ci.yml", step(line)), [], line);
  }
  // Piping a download into an interpreter runs it unread; no checksum elsewhere can cover that.
  for (const line of ["curl -fsSL https://e.x/install.sh | sh", "curl -fsSL https://e.x/i | sudo bash -s --", "wget -qO- https://e.x/i.py | python3"]) {
    assert.match(checkDownloads("ci.yml", step(line, sum)).join(), /pipes a download into `(sh|bash|python3)`/, line);
  }
  // A comment is not a command.
  assert.deepEqual(checkDownloads("ci.yml", step("# curl -o x https://e.x/x")), []);
});

test("rules 14 and 15 run over the whole repository, local actions included", (t) => {
  const found = failures(fixture(t, {
    "services/api/Dockerfile": "FROM node:24-alpine\nRUN echo ok\n",
    ".github/actions/setup-tool/action.yml": "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl -fsSLo tool.tgz https://e.x/tool.tgz\n",
  }));
  assert.match(found, /services\/api\/Dockerfile:1 names base image `node:24-alpine` by tag alone/);
  assert.match(found, /\.github\/actions\/setup-tool\/action\.yml:5 downloads a file with no checksum/);
});

test("a repository with nothing tracked is fatal, not vacuously clean", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".gitignore"), IGNORE);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  assert.match(checkRepoHygiene(root).fatal ?? "", /nothing is tracked/);
});

test("a directory that is not a git repository is fatal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".gitignore"), IGNORE);
  assert.match(checkRepoHygiene(root).fatal ?? "", /git repository/);
});

test("rule 16: a version written into a workflow fails; one read from the manifest or a file does not", () => {
  const workflow = [
    "env:",
    '  SHELLCHECK_VERSION: "0.10.0"',
    "  # TOOL_VERSION: \"1.0.0\" in a comment is not a pin",
    "steps:",
    "  - uses: actions/setup-node@0000000000000000000000000000000000000000 # v7.0.0",
    "    with:",
    "      node-version: 24",
    "  - run: go run example.com/tool@v1.2.3 ./...",
    "  - run: uvx tool==4.5.6",
    "  - run: curl -o x https://github.com/o/r/releases/download/v1.0.0/x.tgz",
    "  - uses: golangci/golangci-lint-action@0000000000000000000000000000000000000000 # v9.3.0",
    "    with:",
    "      version: v2.13.2",
    "  - run: node scripts/tools.mjs install actionlint",
    "  - uses: astral-sh/setup-uv@0000000000000000000000000000000000000000 # v10.1.0",
    "    with:",
    "      version: ${{ steps.uv.outputs.version }}",
    "      node-version-file: .node-version",
  ].join("\n");
  const found = checkPins("ci.yml", workflow);
  assert.deepEqual(found.map((f) => f.split(" ")[0]), ["ci.yml:2", "ci.yml:7", "ci.yml:8", "ci.yml:9", "ci.yml:10", "ci.yml:13"]);
  assert.match(found[0], /a tool version in an environment variable/);
  assert.match(found[1], /a toolchain version/);
});


// Rule 17 over an in-memory repository in which every copy agrees; each test changes one thing.
const DIGEST = `@sha256:${"a".repeat(64)}`;
const AGREEING = {
  ".node-version": "24\n",
  "package.json": JSON.stringify({ engines: { node: ">=24" } }),
  "apps/web/package.json": JSON.stringify({ engines: { node: ">=24" }, devDependencies: { "@types/node": "^24.1.0", "@biomejs/biome": "2.5.14" } }),
  "services/api-ts/package.json": JSON.stringify({ engines: { node: ">=24" }, devDependencies: { "@types/node": "^24.13.5", "@biomejs/biome": "2.5.14" } }),
  "services/api-ts/Dockerfile": `FROM node:24-alpine${DIGEST}\n`,
  "services/api-go/go.mod": "module example.test/api\n\ngo 1.26.1\n",
  "services/api-go/Dockerfile": `FROM --platform=$BUILDPLATFORM golang:1.26-alpine${DIGEST} AS build\nFROM gcr.io/distroless/static-debian13:nonroot${DIGEST}\nCOPY --from=build /api /api\n`,
  "services/api-py/.python-version": "3.14\n",
  "services/api-py/pyproject.toml": '[project]\nrequires-python = ">=3.13"\n\n[tool.uv]\nrequired-version = ">=0.12.5,<0.13"\n\n[tool.mypy]\npython_version = "3.13"\n',
  "services/api-py/Dockerfile": `FROM python:3.14-slim${DIGEST}\n`,
  "scripts/tools/tools.json": JSON.stringify({ tools: { uv: { version: "0.12.18" }, "golangci-lint": { version: "2.13.2", devcontainer: { go: "golangciLintVersion" } } } }),
  ".devcontainer/devcontainer.json": `{
  // Comments and trailing commas, as the real file may have them.
  "features": {
    "ghcr.io/devcontainers/features/go:1": { "version": "1.26", "golangciLintVersion": "2.13.2" },
    "ghcr.io/devcontainers/features/python:1": { "version": "3.14", "installTools": false },
    "ghcr.io/devcontainers/features/node:2": "24",
  },
}`,
};
const versions = (changes = {}) => {
  const files = { ...AGREEING, ...changes };
  const present = Object.keys(files).filter((path) => files[path] !== null);
  return checkVersions(present, (path) => files[path]);
};
const devcontainer = (from, to) => ({ ".devcontainer/devcontainer.json": AGREEING[".devcontainer/devcontainer.json"].replace(from, to) });

test("rule 17: toolchain copies that agree with their declarations pass", () => {
  assert.deepEqual(versions(), []);
});

test("rule 17: changing .node-version alone names every copy still on the old major", () => {
  const found = versions({ ".node-version": "26.1.0\n" });
  for (const copy of [
    /`package\.json` requires Node `>=24`, but `\.node-version` declares Node 26/,
    /`apps\/web\/package\.json` requires Node/,
    /`services\/api-ts\/package\.json` requires Node/,
    /`apps\/web\/package\.json` types its code against @types\/node `\^24\.1\.0`/,
    /`services\/api-ts\/package\.json` types its code against @types\/node/,
    /`services\/api-ts\/Dockerfile:1` builds on node `24-alpine`/,
    /`\.devcontainer\/devcontainer\.json` installs Node through `ghcr\.io\/devcontainers\/features\/node:2` at `24`/,
  ]) {
    assert.equal(found.filter((f) => copy.test(f)).length, 1, `expected one failure matching ${copy}, got:\n${found.join("\n")}`);
  }
  assert.equal(found.length, 7, found.join("\n"));
});

test("rule 17: a go.mod or .python-version moved alone fails at the image and the Dev Container", () => {
  const go = versions({ "services/api-go/go.mod": "module example.test/api\n\ngo 1.27\n" }).join("\n");
  assert.match(go, /`services\/api-go\/Dockerfile:1` builds on golang `1\.26-alpine`, but `services\/api-go\/go\.mod` declares Go 1\.27/);
  assert.match(go, /installs Go through `ghcr\.io\/devcontainers\/features\/go:1` at `1\.26`/);
  assert.doesNotMatch(go, /distroless|Dockerfile:2/, "an image that carries no toolchain is not compared");
  const python = versions({ "services/api-py/.python-version": "3.15\n" }).join("\n");
  assert.match(python, /`services\/api-py\/Dockerfile:1` builds on python `3\.14-slim`, but `services\/api-py\/\.python-version` declares Python 3\.15/);
  assert.match(python, /installs Python through .* at `3\.14`/);
  assert.match(versions({ "services/api-go/Dockerfile": `FROM golang${DIGEST}\n` }).join(), /Dockerfile:1` builds on golang with no tag/);
});

test("rule 17: Python outside requires-python, mypy off its floor, and uv outside required-version fail", () => {
  const pyproject = AGREEING["services/api-py/pyproject.toml"];
  assert.match(versions({ "services/api-py/.python-version": "3.12\n", "services/api-py/Dockerfile": `FROM python:3.12-slim${DIGEST}\n`, ...devcontainer('"3.14"', '"3.12"') }).join(), /declares Python 3\.12, outside `services\/api-py\/pyproject\.toml`'s requires-python `>=3\.13`/);
  assert.match(versions({ "services/api-py/pyproject.toml": pyproject.replace('python_version = "3.13"', 'python_version = "3.14"') }).join(), /type-checks against Python 3\.14 \(\[tool\.mypy\] python_version\), but its requires-python floor is 3\.13/);
  assert.match(versions({ "scripts/tools/tools.json": AGREEING["scripts/tools/tools.json"].replace("0.12.18", "0.13.0") }).join(), /pins uv 0\.13\.0, outside `services\/api-py\/pyproject\.toml`'s required-version `>=0\.12\.5,<0\.13`/);
  assert.match(versions({ "services/api-py/pyproject.toml": pyproject.replace(">=0.12.5,<0.13", "0.12") }).join(), /cannot read the version specifier `0\.12`/);
});

test("rule 17: the Dev Container installs no tool at a version nothing pins", () => {
  // The Dev Container as v1.1.0 shipped it: uv from the python feature's tool list, golangci-lint at latest.
  const shipped = versions(devcontainer('{ "version": "3.14", "installTools": false }', '{ "version": "3.14", "toolsToInstall": "uv" }')).join();
  assert.match(shipped, /lets `ghcr\.io\/devcontainers\/features\/python:1` install its own tools, at unpinned versions\. Set `"installTools": false`/);
  assert.match(versions(devcontainer(', "golangciLintVersion": "2.13.2"', "")).join(), /installs golangci-lint through `ghcr\.io\/devcontainers\/features\/go:1` at the feature's default \(latest\), but `scripts\/tools\/tools\.json` pins 2\.13\.2/);
  assert.match(versions(devcontainer('"golangciLintVersion": "2.13.2"', '"golangciLintVersion": "2.12.0"')).join(), /at `2\.12\.0`, but .* pins 2\.13\.2\. Set `golangciLintVersion` to 2\.13\.2/);
  assert.match(versions(devcontainer('node:2": "24"', 'node:2": "lts"')).join(), /installs Node through .* at `lts`/);
  assert.match(versions(devcontainer('node:2": "24"', 'node:2": {}')).join(), /installs Node through .* at the feature's default/);
  assert.match(versions({ ".devcontainer/devcontainer.json": "{ features: }" }).join(), /devcontainer\.json` does not parse/);
});

test("rule 17: two Biome versions fail, naming each; a nested declaration governs only its own directory", () => {
  const web = JSON.parse(AGREEING["apps/web/package.json"]);
  web.devDependencies["@biomejs/biome"] = "2.5.13";
  assert.match(versions({ "apps/web/package.json": JSON.stringify(web) }).join(), /Biome is pinned at different versions: `2\.5\.13` in `apps\/web\/package\.json`, `2\.5\.14` in `services\/api-ts\/package\.json`/);
  // apps/web's own declaration governs apps/web, and nothing else in the repository; the Dev Container has
  // one Node, so it must agree with every declaration and names the one it does not.
  const nested = versions({ "apps/web/.node-version": "26\n" });
  assert.equal(nested.length, 3, nested.join("\n"));
  assert.ok(nested.every((f) => f.includes("`apps/web/.node-version` declares Node 26") && /apps\/web\/package\.json|devcontainer\.json/.test(f)), nested.join("\n"));
  assert.match(versions({ "services/api-py/.python-version": "system\n" }).join(), /declares `system`, which is not a Python version this rule can compare/);
  assert.deepEqual(versions({ "services/api-go/go.mod": null }).filter((f) => /golang|go through/.test(f)), [], "with no go.mod, nothing declares Go and nothing is compared");
});

test("rule 17's readers: versions, PEP 440 ranges, TOML tables and JSON with comments", () => {
  assert.equal(leadingVersion(">=24.3", 1), "24");
  assert.equal(leadingVersion("1.26-alpine", 2), "1.26");
  assert.equal(leadingVersion("3", 2), null);
  assert.equal(leadingVersion(undefined, 1), null);
  assert.ok(satisfies("0.12.18", ">=0.12.5,<0.13"));
  assert.ok(!satisfies("0.13.0", ">=0.12.5,<0.13"));
  assert.ok(satisfies("3.14", ">=3.13") && !satisfies("3.12.9", ">=3.13"));
  assert.ok(satisfies("1.4.2", "~=1.4.0") && !satisfies("1.5.0", "~=1.4.0") && satisfies("1.9", "~=1.4"));
  assert.ok(satisfies("2.1.7", "==2.1.*") && !satisfies("2.2.0", "==2.1.*") && satisfies("2.2.0", "!=2.1.*"));
  assert.throws(() => satisfies("1.0.0", ">=1.0,foo"), /cannot read the version specifier `foo`/);
  assert.equal(specifierFloor(">=3.11,<4,>=3.13"), "3.13");
  assert.equal(specifierFloor("<4"), null);
  const toml = '[project]\nname = "x"\nrequires-python = ">=3.13"\n\n[tool.uv]\nrequired-version = \'>=0.12\'\n[tool.mypy]\npython_version = "3.13" # oldest\n';
  assert.equal(tomlString(toml, "project", "requires-python"), ">=3.13");
  assert.equal(tomlString(toml, "tool.uv", "required-version"), ">=0.12");
  assert.equal(tomlString(toml, "tool.mypy", "python_version"), "3.13");
  assert.equal(tomlString(toml, "tool.mypy", "requires-python"), null, "a key is read only from its own table");
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x//y", /* b */ "b": [1, 2,], "c": "q\\"//",\n "d": {"e": 1, // last\n },\n}'), { a: "http://x//y", b: [1, 2], c: 'q"//', d: { e: 1 } });
  assert.deepEqual(parseJsonc('{"a": ",}"}'), { a: ",}" });
});

test("rule 17 runs over the whole repository", (t) => {
  const root = fixture(t, { ".node-version": "26\n", "package.json": JSON.stringify({ engines: { node: ">=24" } }) });
  assert.match(failures(root), /`package\.json` requires Node `>=24`, but `\.node-version` declares Node 26/);
});
