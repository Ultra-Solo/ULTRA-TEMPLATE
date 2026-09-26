/**
 * The hand-pinned tools, from their one manifest: scripts/tools/tools.json.
 *
 * Dependabot moves actions, images and module dependencies. The tools a workflow downloads by version
 * it cannot see, so each is written once, in the manifest, with the SHA-256 of its release asset, and
 * everything that needs one reads it from there: the workflows, local checks and the agent environment.
 *
 *   node scripts/tools.mjs install actionlint zizmor   # download, check the SHA-256, unpack onto PATH
 *   node scripts/tools.mjs install --local             # what this checkout's modules need and PATH lacks
 *   node scripts/tools.mjs install --for go,python     # the tools of these toolchains (a module's CI job)
 *   node scripts/tools.mjs version uv                  # print a pinned version
 *   node scripts/tools.mjs run govulncheck -- ./...    # run a tool the manifest runs by version
 *   node scripts/tools.mjs check golangci-lint         # is the one on PATH the pinned one?
 *   node scripts/tools.mjs bump trivy [X.Y.Z]          # move a pin; the checksum comes from the release
 *
 * `install` writes into --dir, or into $RUNNER_TEMP/tools in GitHub Actions (added to $GITHUB_PATH), or
 * into .tools/bin here. It checks the SHA-256 before unpacking anything, so a replaced asset fails.
 *
 * Written for older Node versions than the one .node-version pins, because the agent environment may
 * run it to install that Node. Exit 0 done · 1 a check found a mismatch · 2 could not run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The manifest, relative to the repository root, as git lists it. */
export const TOOLS_PATH = "scripts/tools/tools.json";
export const TOOLS_FILE = join(ROOT, ...TOOLS_PATH.split("/"));
/** Where a tool may be needed: everywhere, where a module of a toolchain is present, or only in CI. */
export const PLACES = ["chassis", "go", "node", "python", "ci"];

export class ToolError extends Error {}

export function loadTools(file = TOOLS_FILE) {
  return JSON.parse(readFileSync(file, "utf8")).tools;
}

/** Every way the manifest is malformed, or an empty list. */
export function validateTools(tools) {
  const problems = [];
  for (const [name, tool] of Object.entries(tools)) {
    const say = (message) => problems.push(`${name}: ${message}`);
    if (!/^\d+\.\d+\.\d+$/.test(tool.version ?? "")) say("`version` must be X.Y.Z");
    if (!PLACES.includes(tool.for)) say(`\`for\` must be one of ${PLACES.join(", ")}`);
    const sources = ["github", "githubTags", "pypi"].filter((key) => key in (tool.releases ?? {}));
    if (sources.length !== 1) say("`releases` must name one of github, githubTags, pypi");
    if (("platforms" in tool) === ("run" in tool)) say("a tool is either downloaded (`platforms`) or run by version (`run`)");
    for (const [platform, asset] of Object.entries(tool.platforms ?? {})) {
      if (!/^https:\/\//.test(asset.url ?? "")) say(`${platform}: \`url\` must be https`);
      if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) say(`${platform}: \`sha256\` must be 64 hex characters`);
      if (!Array.isArray(asset.files) || asset.files.length === 0) say(`${platform}: \`files\` lists what to unpack`);
    }
    if ("platforms" in tool && !["file", "sidecar", "githubDigest"].some((key) => key in (tool.checksums ?? {}))) {
      say("`checksums` must say where the release publishes its checksum: file, sidecar or githubDigest");
    }
    if ("check" in tool && (!Array.isArray(tool.check) || tool.check.length === 0 || tool.for !== "chassis")) say("`check` is the command verify runs for a chassis tool");
    if ("uses" in tool && (!("check" in tool) || !Array.isArray(tool.uses) || tool.uses.length === 0 || !tool.uses.every((c) => typeof c === "string" && /^[\w.-]+$/.test(c)))) {
      say("`uses` lists the commands a tool's `check` runs when they are on PATH and quietly goes without otherwise");
    }
    // A helper pinned here is installed with the tool that uses it, so it must be installable everywhere that tool is.
    for (const helper of Array.isArray(tool.uses) ? tool.uses.filter((h) => h in tools) : []) {
      const covered = Object.keys(tool.platforms ?? {}).every((key) => key in (tools[helper].platforms ?? {}));
      if (tools[helper].for !== tool.for || !covered) say(`\`uses\` ${helper}, which this manifest pins, so it needs \`for\` "${tool.for}" and an asset for every platform ${name} has`);
    }
    if ("actions" in tool && (!Array.isArray(tool.actions) || !tool.actions.every((a) => typeof a === "string" && /^[\w.-]+\/[\w.-]+$/.test(a)))) {
      say("`actions` lists the OWNER/REPO of each setup action that would install this tool outside its pin");
    }
    for (const [feature, option] of Object.entries(tool.devcontainer ?? {})) {
      if (typeof option !== "string" || option === "") say(`\`devcontainer.${feature}\` names the Dev Container feature option that sets this tool's version`);
    }
    if ("sidecar" in (tool.checksums ?? {}) && !/^\.[\w.]+$/.test(tool.checksums.sidecar)) {
      say("`checksums.sidecar` is the suffix the release appends to each asset's URL, such as .sha256");
    }
  }
  return problems;
}

const fill = (template, tool) => template.replaceAll("{version}", tool.version);

export function platform() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] ?? process.arch;
  return `${process.platform}-${arch}`;
}

function need(tools, name) {
  if (!(name in tools)) throw new ToolError(`no tool named ${name} in scripts/tools/tools.json. Known: ${Object.keys(tools).join(", ")}.`);
  return tools[name];
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Downloads a tool's asset for this platform, refuses it unless its SHA-256 is the pinned one, and
 * copies the listed files into `dir`. Returns the paths written.
 */
export async function install(name, { tools = loadTools(), dir, fetch = globalThis.fetch } = {}) {
  const tool = need(tools, name);
  if (!tool.platforms) throw new ToolError(`${name} is run by version, not installed; use \`node scripts/tools.mjs run ${name}\`.`);
  const asset = tool.platforms[platform()];
  if (!asset) throw new ToolError(`${name} has no pinned asset for ${platform()}; add one to scripts/tools/tools.json.`);
  const url = fill(asset.url, tool);
  const response = await fetch(url);
  if (!response.ok) throw new ToolError(`${name}: ${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new ToolError(`${name}: ${url} has SHA-256 ${actual}, not the pinned ${asset.sha256}. The asset was replaced, or the pin is wrong: nothing was unpacked.`);
  }
  const work = mkdtempSync(join(tmpdir(), `tool-${name}-`));
  try {
    const archive = join(work, basename(new URL(url).pathname));
    writeFileSync(archive, bytes);
    // tar reads the compression from the archive itself: gzip for most releases, xz for shellcheck's.
    const unpacked = spawnSync("tar", ["-xf", archive, "-C", work], { encoding: "utf8" });
    if (unpacked.status !== 0) throw new ToolError(`${name}: could not unpack ${basename(archive)}: ${unpacked.stderr || unpacked.error}`);
    mkdirSync(dir, { recursive: true });
    return asset.files.map((member) => {
      const from = join(work, fill(member, tool));
      if (!existsSync(from)) throw new ToolError(`${name}: ${fill(member, tool)} is not in ${basename(archive)}`);
      const to = join(dir, basename(from));
      copyFileSync(from, to);
      chmodSync(to, 0o755);
      return to;
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The command that runs a tool the manifest runs by version, with `args` after it. */
export function command(name, args = [], tools = loadTools()) {
  const tool = need(tools, name);
  if (!tool.run) throw new ToolError(`${name} is installed, not run by version; use \`node scripts/tools.mjs install ${name}\`.`);
  return [...tool.run.map((part) => fill(part, tool)), ...args];
}

const onPath = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

/**
 * What keeps each command a tool's check `uses` from being the one CI runs: it is not on PATH, or this
 * manifest pins it too and it is another version. Such a check still passes, having checked less or by
 * other rules, so verify names each one rather than letting the pass stand for the whole check.
 */
export function helperProblems(tool, { tools = loadTools(), found = (name) => installedVersion(name, tools), has = onPath } = {}) {
  return (tool.uses ?? []).flatMap((helper) => {
    if (!(helper in tools)) return has(helper) ? [] : [{ helper, missing: true }];
    const version = found(helper);
    if (version === null) return [{ helper, missing: true }];
    const wrong = versionProblem(helper, version, tools);
    return wrong ? [{ helper, wrong }] : [];
  });
}

/** `names`, each followed by the commands its check `uses` that this manifest pins: a tool is installed with what CI runs it with. */
export const withHelpers = (names, tools = loadTools()) => [...new Set(names.flatMap((name) => [name, ...(tools[name]?.uses ?? []).filter((helper) => helper in tools)]))];

/**
 * What verify does about each chassis tool with a `check`: run it, or record why not. A tool, or a pinned
 * helper, at another version than its pin fails rather than passing by rules CI does not apply. A missing
 * tool is recorded as `missing` (the caller's skip outcome, which fails in CI) when this platform has an
 * asset to install, and as a named skip when it has none, since nothing here could install it.
 */
export function chassisToolPlan(tools, { found = (name) => installedVersion(name, tools), on = platform(), missing = "skipped", helpers = (tool) => helperProblems(tool, { tools }) } = {}) {
  const plan = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.for !== "chassis" || !tool.check) continue;
    const label = `chassis: ${name}`;
    const version = found(name);
    if (version === null) {
      plan.push(
        tool.platforms?.[on]
          ? { name: label, status: missing, note: "not on PATH; node scripts/tools.mjs install --local installs it" }
          : { name: label, status: "skipped", note: `no pinned asset for ${on} in scripts/tools/tools.json, so nothing here can install it` },
      );
      continue;
    }
    const wrong = versionProblem(name, version, tools);
    if (wrong) {
      plan.push({ name: label, status: "fail", note: wrong });
      continue;
    }
    const problems = helpers(tool);
    if (!problems.some((problem) => problem.wrong)) plan.push({ name: label, run: tool.check });
    for (const problem of problems) {
      const fix = problem.helper in tools ? `, and node scripts/tools.mjs install ${name} installs ${problem.helper} here` : "";
      const where = missing === "fail" ? "this CI job must run them" : `CI runs them${fix}`;
      plan.push(
        problem.missing
          ? { name: `${label} with ${problem.helper}`, status: missing, note: `${problem.helper} is not on PATH, so ${name} ran without the rules that need it; ${where}` }
          : { name: `${label} with ${problem.helper}`, status: "fail", note: problem.wrong },
      );
    }
  }
  return plan;
}

/** The version a tool on PATH reports, or null when it is not on PATH. Reads the first X.Y.Z it prints. */
export function installedVersion(name, tools = loadTools()) {
  const tool = need(tools, name);
  if (!tool.versionCommand) return null;
  const [cmd, ...args] = tool.versionCommand;
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  if (out.error || out.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(`${out.stdout}${out.stderr}`)?.[1] ?? null;
}

/**
 * Why the `name` on PATH cannot stand in for the pinned one, or null when it can or the manifest pins no
 * such tool. A different version reads the same rules differently, so a local pass would predict nothing
 * about CI's run (D7 in the v1.2.0 plan: a golangci-lint 2.5 on PATH could not lint a Go 1.26 module).
 */
export function versionProblem(name, found, tools = loadTools()) {
  const tool = tools[name];
  if (!tool?.versionCommand || found === null || found === tool.version) return null;
  return `${name} ${found} is on PATH, but scripts/tools/tools.json pins ${tool.version}, which CI runs. Run node scripts/tools.mjs install --local, and put .tools/bin first on PATH`;
}

/**
 * Which of `names` to install on this machine. A tool already on PATH at its pinned version is left
 * alone, and one with no pinned asset for this platform is reported instead of failing the rest: `--local`
 * sets a machine up as far as the manifest can, and verify names whatever is still missing.
 */
export function localPlan(names, { tools = loadTools(), on = platform(), found = (name) => installedVersion(name, tools) } = {}) {
  const install = [];
  const skipped = [];
  for (const name of names) {
    const { version, platforms } = need(tools, name);
    if (found(name) === version) skipped.push(`${name} ${version} is already on PATH`);
    else if (!platforms?.[on]) skipped.push(`${name} has no pinned asset for ${on}: install ${version} yourself, or add the asset to scripts/tools/tools.json`);
    else install.push(name);
  }
  return { install, skipped };
}

/** The tools that the modules of these toolchains run, and nothing for the chassis or for CI alone. */
export const toolsFor = (toolchains, tools = loadTools()) =>
  Object.entries(tools)
    .filter(([, tool]) => tool.platforms && toolchains.includes(tool.for))
    .map(([name]) => name);

/** The tools a checkout needs locally: the chassis's, and those of every toolchain a module here uses. */
export function localTools(toolchains, tools = loadTools()) {
  return Object.entries(tools)
    .filter(([, tool]) => tool.platforms && (tool.for === "chassis" || toolchains.includes(tool.for)))
    .map(([name]) => name);
}

const STABLE = /^v?\d+\.\d+\.\d+$/;
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest stable version of a tool, from where its manifest entry says it is released. */
export async function latest(name, { tools = loadTools(), fetch = globalThis.fetch, token } = {}) {
  const tool = need(tools, name);
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${path}`, {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) throw new ToolError(`${path} answered ${response.status}`);
    return response.json();
  };
  const { releases } = tool;
  if (releases.github) return (await github(`${releases.github}/releases/latest`)).tag_name.replace(/^v/, "");
  if (releases.githubTags) {
    const tags = (await github(`${releases.githubTags}/tags?per_page=100`)).map((t) => t.name).filter((n) => STABLE.test(n));
    if (tags.length === 0) throw new ToolError(`${releases.githubTags} has no stable tag`);
    return tags.sort(compareVersions).at(-1).replace(/^v/, "");
  }
  const response = await fetch(`https://pypi.org/pypi/${releases.pypi}/json`);
  if (!response.ok) throw new ToolError(`PyPI ${releases.pypi} answered ${response.status}`);
  return (await response.json()).info.version;
}

/** The SHA-256 a release publishes for one asset, from where the manifest says the release publishes it. */
async function publishedChecksum(tool, asset, { fetch, token }) {
  const url = fill(asset.url, tool);
  const file = basename(new URL(url).pathname);
  const text = async (address) => {
    const response = await fetch(address);
    if (!response.ok) throw new ToolError(`${address} answered ${response.status}`);
    return response.text();
  };
  if (tool.checksums.file) {
    const line = (await text(fill(tool.checksums.file, tool))).split(/\r?\n/).find((l) => l.trim().endsWith(` ${file}`) || l.trim().endsWith(`*${file}`));
    if (!line) throw new ToolError(`the release's checksums file does not list ${file}`);
    return line.trim().split(/\s+/)[0];
  }
  if (tool.checksums.sidecar) return (await text(`${url}${tool.checksums.sidecar}`)).trim().split(/\s+/)[0];
  const tag = fill(tool.releases.tag ?? "v{version}", tool);
  const response = await fetch(`https://api.github.com/repos/${tool.releases.github}/releases/tags/${tag}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new ToolError(`release ${tag} of ${tool.releases.github} answered ${response.status}`);
  const digest = (await response.json()).assets?.find((a) => a.name === file)?.digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new ToolError(`GitHub records no SHA-256 for ${file} in ${tag}`);
  return digest.slice("sha256:".length);
}

/**
 * Moves a pin: sets the version (the latest release when none is given) and, for every downloaded
 * asset, the SHA-256 the release itself publishes. Returns the manifest with the change made.
 */
export async function bump(name, version, { tools = loadTools(), fetch = globalThis.fetch, token } = {}) {
  const current = need(tools, name);
  const target = version ?? (await latest(name, { tools, fetch, token }));
  if (!/^\d+\.\d+\.\d+$/.test(target)) throw new ToolError(`${target} is not a version X.Y.Z`);
  const next = { ...current, version: target };
  if (next.platforms) {
    next.platforms = Object.fromEntries(
      await Promise.all(Object.entries(current.platforms).map(async ([key, asset]) => [key, { ...asset, sha256: await publishedChecksum(next, asset, { fetch, token }) }])),
    );
  }
  return { ...tools, [name]: next };
}

function defaultDir() {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_TEMP) return join(process.env.RUNNER_TEMP, "tools");
  return join(ROOT, ".tools", "bin");
}

async function main(argv) {
  const [verb, ...rest] = argv;
  const tools = loadTools();
  const problems = validateTools(tools);
  if (problems.length > 0) throw new ToolError(`scripts/tools/tools.json is malformed:\n  ${problems.join("\n  ")}`);
  if (verb === "install") {
    const dirAt = rest.indexOf("--dir");
    const forAt = rest.indexOf("--for");
    const dir = dirAt === -1 ? defaultDir() : resolve(rest[dirAt + 1]);
    const valueAt = new Set([dirAt, forAt].filter((at) => at !== -1).map((at) => at + 1));
    let names = withHelpers(
      rest.filter((arg, i) => !arg.startsWith("--") && !valueAt.has(i)),
      tools,
    );
    const toolchains = forAt === -1 ? null : (rest[forAt + 1] ?? "").split(",").filter(Boolean);
    if (toolchains) names = [...names, ...toolsFor(toolchains, tools)];
    const local = rest.includes("--local");
    if (local) {
      const { presentModules } = await import("./modules.mjs");
      const plan = localPlan(localTools([...new Set(presentModules().map((m) => m.toolchain))], tools), { tools });
      for (const line of plan.skipped) console.log(`tools: skipped ${line}.`);
      names = [...names, ...plan.install];
    }
    if (names.length === 0 && !local && !toolchains) throw new ToolError("name a tool to install, or pass --local or --for");
    for (const name of new Set(names)) {
      for (const path of await install(name, { tools, dir })) console.log(`tools: installed ${name} ${tools[name].version} at ${path}`);
    }
    if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${dir}\n`);
    else if (names.length > 0 && !(process.env.PATH ?? "").split(delimiter).includes(dir)) console.log(`tools: put ${dir} on PATH to use them.`);
    return 0;
  }
  if (verb === "version") {
    console.log(need(tools, rest[0]).version);
    return 0;
  }
  if (verb === "run") {
    const [name, ...args] = rest;
    const [cmd, ...cmdArgs] = command(name, args[0] === "--" ? args.slice(1) : args, tools);
    const out = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32" });
    return out.status ?? 2;
  }
  if (verb === "check") {
    let code = 0;
    for (const name of rest) {
      const found = installedVersion(name, tools);
      if (found === tools[name].version) console.log(`tools: ${name} ${found}, as pinned`);
      else {
        console.error(`tools: ${name} is ${found ?? "not on PATH"}, but scripts/tools/tools.json pins ${tools[name].version}. Run: node scripts/tools.mjs install ${name}`);
        code = 1;
      }
    }
    return code;
  }
  if (verb === "bump") {
    const [name, version] = rest;
    const next = await bump(name, version, { tools, token: process.env.GH_TOKEN });
    const manifest = JSON.parse(readFileSync(TOOLS_FILE, "utf8"));
    writeFileSync(TOOLS_FILE, `${JSON.stringify({ ...manifest, tools: next }, null, 2)}\n`);
    console.log(`tools: ${name} ${tools[name].version} → ${next[name].version}. Read its release notes, then run node scripts/verify.mjs.`);
    return 0;
  }
  throw new ToolError(`unknown command "${verb ?? ""}": use install, version, run, check or bump`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`tools: ${err instanceof ToolError ? err.message : err.stack}`);
      process.exitCode = 2;
    },
  );
}
