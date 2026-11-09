/**
 * Prepares a coding agent's cloud session with the toolchains CI runs, read from the files that pin
 * them, so the first command the agent runs checks what CI checks (ADR-0016). The SessionStart hook in
 * .claude/settings.json runs it; it does nothing unless CLAUDE_CODE_REMOTE is "true", or --force is given.
 *
 *   node scripts/agent-env.mjs                 # in a Claude Code cloud session
 *   node scripts/agent-env.mjs --force         # on any machine
 *   node scripts/agent-env.mjs --dry-run       # what it would do, with nothing installed or changed
 *   node scripts/agent-env.mjs --oldest-node   # the oldest Node major it runs on, for CI to run it there
 *
 * - Node: the version .node-version names, from nodejs.org, checked against that release's
 *   SHASUMS256.txt, unless the Node running this is already it.
 * - Go, when a Go module is here: GOTOOLCHAIN=auto, so the go command fetches the version go.mod names and
 *   Go's checksum database verifies it. With no go at all, the release go.dev lists, checked against the
 *   SHA-256 it publishes.
 * - The pinned tools the modules here need (scripts/tools/tools.json), as `tools.mjs install --local`
 *   installs them; uv then installs the Python that .python-version names when setup runs.
 * - Then scripts/setup.mjs installs every module's dependencies, with the Node installed above.
 *
 * Everything lands under .tools/, which git ignores, and reaches the session through $CLAUDE_ENV_FILE. A
 * checksum from the server that also served the file proves the download is whole, not who made it.
 * Written for Node 22 and later, because it may be what installs the Node .node-version names.
 * Exit 0 ready, or nothing to do · 2 a step failed, with the reason.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The oldest Node major this script runs on; CI runs it there. */
export const OLDEST_NODE = 22;
export const TOOLS_DIR = join(ROOT, ".tools");

class EnvError extends Error {}

/** Node's name for this platform in its release files, such as linux-x64. */
export function nodePlatform(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new EnvError(`no Node release is picked for ${platform}-${arch} here; install Node ${readNodeVersion()} yourself`);
  return `${os}-${cpu}`;
}

/** What .node-version asks for: a major such as "24", or an exact version such as "24.13.0". */
export function readNodeVersion(root = ROOT) {
  return readFileSync(join(root, ".node-version"), "utf8").trim().replace(/^v/, "");
}

/** Where the SHASUMS256.txt of the release `wanted` names is: an exact release, or the newest of a major. */
export const nodeIndexUrl = (wanted) => (/^\d+\.\d+\.\d+$/.test(wanted) ? `https://nodejs.org/dist/v${wanted}/SHASUMS256.txt` : `https://nodejs.org/dist/latest-v${wanted.split(".")[0]}.x/SHASUMS256.txt`);

/** The tarball for `platform` in a release's SHASUMS256.txt, as {file, version, sha256}. */
export function nodeRelease(shasums, platform) {
  for (const line of shasums.split(/\r?\n/)) {
    const entry = /^([0-9a-f]{64})\s+(node-v(\d+\.\d+\.\d+)-([\w-]+)\.tar\.gz)$/.exec(line.trim());
    if (entry && entry[4] === platform) return { sha256: entry[1], file: entry[2], version: entry[3] };
  }
  throw new EnvError(`the release lists no node tarball for ${platform}`);
}

/** The newest stable Go release for the Go version go.mod names, from go.dev's list, as {file, version, sha256}. */
export function goRelease(releases, goVersion, platform = process.platform, arch = process.arch) {
  const goos = { linux: "linux", darwin: "darwin" }[platform];
  const goarch = { x64: "amd64", arm64: "arm64" }[arch];
  const series = `go${goVersion.split(".").slice(0, 2).join(".")}`;
  for (const release of releases) {
    if (!release.stable || !(release.version === series || release.version.startsWith(`${series}.`))) continue;
    const file = release.files.find((f) => f.os === goos && f.arch === goarch && f.kind === "archive");
    if (file) return { file: file.filename, version: release.version, sha256: file.sha256 };
  }
  throw new EnvError(`go.dev lists no stable ${series} release for ${platform}-${arch}`);
}

/**
 * Why a session start needs nothing done, from the hook's input, or null. Clearing or compacting the
 * conversation keeps the container this already prepared; a new or resumed session may not.
 */
export function alreadyPrepared(input) {
  let source;
  try {
    source = JSON.parse(input || "{}").source;
  } catch {
    return null;
  }
  return source === "clear" || source === "compact" ? `a ${source} keeps the session this already prepared` : null;
}

/** The lines written to $CLAUDE_ENV_FILE: PATH with every directory set up here first, and Go's toolchain rule. */
export function envLines({ paths, go }) {
  return [`export PATH="${paths.join(delimiter)}${delimiter}$PATH"`, ...(go ? ["export GOTOOLCHAIN=auto"] : [])];
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Downloads `url`: with curl when it is here, since curl follows the machine's proxy settings, which
 * fetch in older Node does not; otherwise with fetch.
 */
async function download(url) {
  const curl = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", url], { maxBuffer: 512 * 1024 * 1024 });
  if (!curl.error) {
    if (curl.status !== 0) throw new EnvError(`${url}: ${String(curl.stderr).trim()}`);
    return curl.stdout;
  }
  const response = await fetch(url);
  if (!response.ok) throw new EnvError(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads an archive, refuses it unless its SHA-256 is `expected`, and unpacks it to `into`. */
async function unpackVerified(url, expected, into) {
  const bytes = await download(url);
  if (sha256(bytes) !== expected) throw new EnvError(`${url} has SHA-256 ${sha256(bytes)}, not the published ${expected}; nothing was unpacked`);
  const staging = `${into}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(tmpdir(), `agent-env-${process.pid}.tar.gz`);
  writeFileSync(archive, bytes);
  try {
    const unpacked = spawnSync("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"], { encoding: "utf8" });
    if (unpacked.status !== 0) throw new EnvError(`could not unpack ${url}: ${unpacked.stderr}`);
  } finally {
    rmSync(archive, { force: true });
  }
  rmSync(into, { recursive: true, force: true });
  renameSync(staging, into);
}

const versionOf = (command, args) => {
  const out = spawnSync(command, args, { encoding: "utf8" });
  return out.status === 0 ? /(\d+\.\d+\.\d+)/.exec(`${out.stdout}${out.stderr}`)?.[1] ?? null : null;
};

async function prepareNode(plan, dryRun) {
  const wanted = readNodeVersion();
  const running = process.versions.node;
  const satisfied = (version) => version !== null && (wanted.includes(".") ? version === wanted : version.split(".")[0] === wanted);
  if (satisfied(running)) return { node: process.execPath, note: `Node ${running}, as .node-version asks` };
  const home = join(TOOLS_DIR, "node");
  const release = nodeRelease((await download(nodeIndexUrl(wanted))).toString("utf8"), nodePlatform());
  const bin = join(home, "bin", "node");
  if (versionOf(bin, ["--version"]) !== release.version) {
    plan.push(`Node ${release.version} from ${release.file}`);
    if (!dryRun) await unpackVerified(`${dirname(nodeIndexUrl(wanted))}/${release.file}`, release.sha256, home);
  }
  return { node: bin, dir: join(home, "bin"), note: `Node ${release.version} (this was ${running})` };
}

async function prepareGo(plan, dryRun, modules) {
  const goModule = modules.find((m) => m.toolchain === "go");
  if (!goModule) return null;
  if (versionOf("go", ["version"]) !== null) return { note: "go, with GOTOOLCHAIN=auto choosing the version go.mod names" };
  const goVersion = /^go\s+(\S+)/m.exec(readFileSync(join(ROOT, goModule.dir, "go.mod"), "utf8"))?.[1];
  if (!goVersion) throw new EnvError(`${goModule.dir}/go.mod names no go version`);
  const release = goRelease(JSON.parse((await download("https://go.dev/dl/?mode=json&include=all")).toString("utf8")), goVersion);
  plan.push(`Go ${release.version} from ${release.file}`);
  if (!dryRun) await unpackVerified(`https://go.dev/dl/${release.file}`, release.sha256, join(TOOLS_DIR, "go"));
  return { dir: join(TOOLS_DIR, "go", "bin"), note: `${release.version}, with GOTOOLCHAIN=auto` };
}

async function main(argv) {
  if (argv.includes("--oldest-node")) {
    console.log(OLDEST_NODE);
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  if (process.env.CLAUDE_CODE_REMOTE !== "true" && !argv.includes("--force") && !dryRun) {
    console.log("agent-env: not a Claude Code cloud session, so nothing to do. --force runs it anyway.");
    return 0;
  }
  // The hook passes what started the session on stdin; a person at a terminal passes nothing.
  const done = process.stdin.isTTY ? null : alreadyPrepared(readFileSync(0, "utf8"));
  if (done) {
    console.log(`agent-env: nothing to do; ${done}.`);
    return 0;
  }
  const { presentModules } = await import("./modules.mjs");
  const tools = await import("./tools.mjs");
  const modules = presentModules();
  const plan = [];
  const node = await prepareNode(plan, dryRun);
  const go = await prepareGo(plan, dryRun, modules);
  const binDir = join(TOOLS_DIR, "bin");
  const paths = [node.dir, go?.dir, binDir].filter(Boolean);
  // The tools already on PATH at their pin are kept; .tools/bin goes first, so what is installed wins.
  process.env.PATH = [...paths, process.env.PATH].join(delimiter);
  const wanted = tools.localTools([...new Set(modules.map((m) => m.toolchain))]);
  const { install, skipped } = tools.localPlan(wanted);
  for (const name of install) {
    plan.push(`${name} ${tools.loadTools()[name].version}`);
    if (!dryRun) await tools.install(name, { dir: binDir, fetch: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => download(url) }) });
  }
  const lines = envLines({ paths, go: go !== null });
  if (dryRun) {
    console.log(`agent-env: would install ${plan.join(", ") || "nothing"}; ${skipped.join("; ") || "no tool skipped"}; then run setup.mjs and add to the session:\n  ${lines.join("\n  ")}`);
    return 0;
  }
  if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `${lines.join("\n")}\n`);
  else console.log(`agent-env: no CLAUDE_ENV_FILE; for this shell run:\n  ${lines.join("\n  ")}`);
  const setup = spawnSync(node.node, [join(ROOT, "scripts", "setup.mjs")], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...(go ? { GOTOOLCHAIN: "auto" } : {}) } });
  if (setup.status !== 0) throw new EnvError(`setup.mjs exited ${setup.status}`);
  console.log(`agent-env: ready. ${[node.note, go?.note].filter(Boolean).join("; ")}; installed ${plan.join(", ") || "nothing new"}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`agent-env: ${err instanceof EnvError ? err.message : err.stack}`);
      process.exitCode = 2;
    },
  );
}
