/**
 * The modules a checkout contains, found from the manifests they carry, and the one place that knows
 * how to run a command for them.
 *
 * A module is a directory holding a `module.json` (MANIFEST): it names the module, its toolchain, the
 * checks it runs, and what else it takes part in (the task API contract, the task facts, a container
 * image). No script lists the modules. Adding one is adding a directory with its manifest, a verify.yml
 * job and a Dependabot entry; deleting it removes it from setup and verify, and check-hygiene rule 13
 * names the job and the entry that must go with it (ADR-0014).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST = "module.json";

/**
 * What each toolchain is: the command that must be on PATH, the manifest and lockfile a module of it
 * commits, and how its dependencies install. `install` installs exactly what the lockfile pins and
 * refuses a lockfile that no longer matches; `installUnlocked` writes the first lockfile of a new
 * module, which rule 13 then requires to be committed. npm installs never run a dependency's scripts.
 */
export const TOOLCHAINS = {
  node: {
    command: "npm",
    probe: ["--version"],
    manifest: "package.json",
    lockfile: "package-lock.json",
    installed: "node_modules",
    install: ["npm", "ci", "--ignore-scripts"],
    installUnlocked: ["npm", "install", "--ignore-scripts"],
  },
  go: { command: "go", probe: ["version"], manifest: "go.mod", lockfile: null, installed: null, install: ["go", "mod", "download"], installUnlocked: null },
  python: {
    command: "uv",
    probe: ["--version"],
    manifest: "pyproject.toml",
    lockfile: "uv.lock",
    installed: null,
    install: ["uv", "sync", "--locked"],
    installUnlocked: ["uv", "sync"],
  },
};

/**
 * The conditions a check may declare it needs. A check whose condition does not hold runs its
 * `otherwise` command, if it names one, and is reported as skipped by name: never silently passed.
 */
export const REQUIREMENTS = {
  // The race detector needs cgo and the C compiler Go would call.
  cgo: (cwd) => {
    const cc = run("go", ["env", "CC"], { cwd, capture: true }).stdout.trim() || "gcc";
    return run("go", ["env", "CGO_ENABLED"], { cwd, capture: true }).stdout.trim() === "1" && available(cc, ["--version"]);
  },
};

/**
 * The facts a module may say it repeats. Each is stated in one file, and scripts/check-facts.mjs compares
 * a module's copy with it; test/check-facts.test.mjs holds this list to the facts those files state.
 */
export const FACTS = ["statuses", "transitions", "maxTitleLength", "titleWhitespace", "apiDefaultPort"];
/**
 * How a module's container image is probed in CI (scripts/probe-image.mjs): "http" serves the task API
 * and is held to the contract, or {"run": command} probes the image with the module's own command.
 */
export const IMAGE_PROBES = ["http"];

export class ModuleError extends Error {}

/**
 * What a declared skip is: skipped on a machine that lacks the tool or condition, and a failure in
 * GitHub Actions, where the module's job always has it, so a job that lost it cannot pass unchecked.
 */
export const skipOutcome = (env = process.env) => (env.GITHUB_ACTIONS === "true" ? "fail" : "skipped");

const isCommand = (value) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part !== "");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const unknownKeys = (value, allowed) => Object.keys(value).filter((key) => !allowed.includes(key));

/**
 * Every way a manifest is malformed, or an empty list. The schema is closed: an unknown key is an error,
 * because a misspelt one is otherwise a setting that silently does nothing.
 */
export function validateManifest(manifest, where = MANIFEST) {
  if (!isObject(manifest)) return [`${where} is not a JSON object`];
  const problems = [];
  const say = (message) => problems.push(`${where}: ${message}`);
  for (const key of unknownKeys(manifest, ["id", "toolchain", "checks", "coverage", "taskApi", "facts", "e2e", "image"])) say(`unknown key \`${key}\``);
  if (typeof manifest.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(manifest.id)) say("`id` must be lowercase letters, digits and hyphens, starting with a letter");
  if (!(manifest.toolchain in TOOLCHAINS)) say(`\`toolchain\` must be one of ${Object.keys(TOOLCHAINS).join(", ")}`);
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) say("`checks` must list at least one check");
  for (const [i, check] of (Array.isArray(manifest.checks) ? manifest.checks : []).entries()) {
    const at = `checks[${i}]`;
    if (!isObject(check)) {
      say(`${at} is not an object`);
      continue;
    }
    for (const key of unknownKeys(check, ["name", "run", "expect", "requires", "otherwise", "tool", "why"])) say(`${at} has unknown key \`${key}\``);
    if (typeof check.name !== "string" || check.name === "") say(`${at} needs a \`name\``);
    if (!isCommand(check.run)) say(`${at}.run must be a command: a list of strings`);
    if (check.expect !== undefined && check.expect !== "no-output") say(`${at}.expect can only be "no-output"`);
    if (check.requires !== undefined && !(check.requires in REQUIREMENTS)) say(`${at}.requires must be one of ${Object.keys(REQUIREMENTS).join(", ")}`);
    if (check.otherwise !== undefined && (check.requires === undefined || !isObject(check.otherwise) || typeof check.otherwise.name !== "string" || !isCommand(check.otherwise.run))) {
      say(`${at}.otherwise needs \`requires\`, and is {"name", "run"}`);
    }
    if (check.tool !== undefined && check.tool !== check.run?.[0]) say(`${at}.tool must name the command the check runs`);
    if (check.why !== undefined && typeof check.why !== "string") say(`${at}.why must be a string`);
  }
  if (manifest.coverage !== undefined) {
    const { coverage } = manifest;
    if (!isObject(coverage) || !Array.isArray(coverage.run) || !coverage.run.every(isCommand) || typeof coverage.report !== "string" || unknownKeys(coverage, ["run", "report"]).length > 0) {
      say("`coverage` is {\"run\": [commands], \"report\": path}");
    }
  }
  if (manifest.taskApi !== undefined) {
    const api = manifest.taskApi;
    if (!isObject(api) || !isCommand(api.run) || (api.build !== undefined && !isCommand(api.build)) || unknownKeys(api, ["build", "run"]).length > 0) {
      say("`taskApi` is {\"build\"?: command, \"run\": command}");
    }
  }
  if (manifest.facts !== undefined) {
    const { facts } = manifest;
    if (!isObject(facts) || !isCommand(facts.run) || !Array.isArray(facts.keys) || facts.keys.length === 0 || unknownKeys(facts, ["run", "keys"]).length > 0) {
      say("`facts` is {\"run\": command, \"keys\": [facts]}");
    } else {
      for (const key of facts.keys) if (!FACTS.includes(key)) say(`facts.keys names \`${key}\`, which is not one of ${FACTS.join(", ")}`);
    }
  }
  if (manifest.e2e !== undefined) {
    const { e2e } = manifest;
    if (!isObject(e2e) || !isCommand(e2e.run) || unknownKeys(e2e, ["run"]).length > 0) say("`e2e` is {\"run\": command}");
    else if (!e2e.run.some((part) => part.includes("{taskApi}"))) say("`e2e.run` must pass the task API's address as {taskApi}");
  }
  if (manifest.image !== undefined) {
    const { image } = manifest;
    if (typeof image === "string") {
      if (!IMAGE_PROBES.includes(image)) say(`\`image\` must be one of ${IMAGE_PROBES.join(", ")}, or {"run": command}`);
      else if (image === "http" && manifest.taskApi === undefined) say("`image: \"http\"` probes the task API, which needs `taskApi`");
    } else if (!isObject(image) || !isCommand(image.run) || unknownKeys(image, ["run"]).length > 0) {
      say(`\`image\` must be one of ${IMAGE_PROBES.join(", ")}, or {"run": command}`);
    } else if (!image.run.some((part) => part.includes("{image}"))) {
      say("`image.run` must name the image it probes as {image}");
    }
  }
  return problems;
}

/**
 * The task service a module's end-to-end check runs against: one present that serves the task API,
 * preferring one on the module's own toolchain so the check needs no other; null when none is present.
 */
export function e2ePartner(module, modules) {
  const services = modules.filter((m) => m.taskApi);
  return services.find((m) => m.toolchain === module.toolchain) ?? services[0] ?? null;
}

// Directories that never hold a module: dependencies, caches, build output and the template machinery.
const SKIP = new Set(["node_modules", "dist", "coverage", "template", "__pycache__"]);
const MAX_DEPTH = 3;

function* manifestsUnder(root, dir = root, depth = 0) {
  if (depth > 0 && existsSync(join(dir, MANIFEST))) {
    yield join(dir, MANIFEST);
    return;
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".") || SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* manifestsUnder(root, path, depth + 1);
  }
}

/**
 * Every module in `root` and every problem with their manifests. `dir` is the module's directory
 * relative to the root, with forward slashes, as git and the workflows write it.
 */
export function loadModules(root = ROOT) {
  const modules = [];
  const problems = [];
  for (const file of manifestsUnder(root)) {
    const dir = relative(root, dirname(file)).split(sep).join("/");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`${dir}/${MANIFEST} is not valid JSON: ${err.message}`);
      continue;
    }
    const found = validateManifest(manifest, `${dir}/${MANIFEST}`);
    if (found.length > 0) problems.push(...found);
    else modules.push({ ...manifest, dir });
  }
  const ids = modules.map((m) => m.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`two modules are named \`${id}\``);
  return { modules, problems };
}

/** The modules present, or a ModuleError naming every malformed manifest: a module that cannot be read must not be skipped. */
export function presentModules(root = ROOT) {
  const { modules, problems } = loadModules(root);
  if (problems.length > 0) throw new ModuleError(`malformed module manifest(s):\n  ${problems.join("\n  ")}`);
  return modules;
}

/**
 * Runs a command and returns its exit status, and its stdout when `capture` is set.
 *
 * On Windows `npm` is a .cmd shim that only a shell can start, so commands go through one there,
 * joined into a single string: every argument this repository passes is a plain token, which is
 * what makes that safe.
 */
export function run(command, args, { cwd = ROOT, capture = false } = {}) {
  const stdio = capture ? ["ignore", "pipe", "inherit"] : "inherit";
  const result = process.platform === "win32"
    ? spawnSync([command, ...args].join(" "), { cwd, stdio, shell: true, encoding: "utf8" })
    : spawnSync(command, args, { cwd, stdio, encoding: "utf8" });
  if (result.error) return { status: 127, stdout: "" };
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

export const available = (command, args = ["version"]) => run(command, args, { capture: true }).status === 0;

/** Where `node scripts/tools.mjs install --local` puts the pinned tools. */
export const TOOLS_BIN = join(ROOT, ".tools", "bin");

/**
 * PATH with `bin` first when it exists, so a pinned tool installed here wins over any other copy for
 * every command verify and setup start; a shell nobody configured still runs what CI runs.
 */
export function withToolsBin(path, bin = TOOLS_BIN, exists = existsSync) {
  if (!exists(bin)) return path;
  return [bin, ...(path ?? "").split(delimiter).filter((entry) => entry !== "" && entry !== bin)].join(delimiter);
}

/**
 * Why the running Node is not the one `.node-version` pins, or null when it is. Only the major version
 * is compared: CI's setup-node reads the same file and installs the newest release of that major, so a
 * different minor is what CI would run too, while a different major type-strips, resolves and reports
 * differently, and a pass on it predicts nothing.
 */
export function nodeVersionProblem(pinned, running = process.versions.node) {
  const want = /^v?(\d+)/.exec(pinned.trim())?.[1];
  const have = /^v?(\d+)/.exec(running)?.[1];
  if (want === undefined) return `.node-version holds "${pinned.trim()}", which names no Node major version.`;
  return want === have ? null : `this is Node ${running}, but .node-version pins Node ${want}, which CI runs. Switch to Node ${want} (nvm, fnm, mise and asdf read .node-version).`;
}

/** nodeVersionProblem for this checkout, or null when it has no .node-version. */
export function checkNodeVersion(root = ROOT) {
  const file = join(root, ".node-version");
  return existsSync(file) ? nodeVersionProblem(readFileSync(file, "utf8")) : null;
}

/**
 * What the modules present need from a machine, as `key=value` lines: each toolchain in use, and for Go
 * the go.mod that names its version, which setup-go reads. Workflows read this instead of restating
 * which feature needs which toolchain. With module ids, only those modules and what they need.
 */
export function toolchainNeeds(modules) {
  const used = new Set(modules.map((m) => m.toolchain));
  const lines = Object.keys(TOOLCHAINS).map((name) => `${name}=${used.has(name)}`);
  const go = modules.find((m) => m.toolchain === "go");
  if (go) lines.push(`go-version-file=${go.dir}/${TOOLCHAINS.go.manifest}`);
  return lines;
}

/**
 * What one module's CI job needs, as .github/actions/module reads it: the toolchains of the module and of
 * the task service its end-to-end check runs against, the tools for those toolchains, the modules to
 * install, and which of the job's steps apply.
 */
export function jobNeeds(module, modules) {
  const partner = module.e2e ? e2ePartner(module, modules) : null;
  const installed = partner ? [module, partner] : [module];
  return [
    ...toolchainNeeds(installed),
    `toolchains=${[...new Set(installed.map((m) => m.toolchain))].join(",")}`,
    `modules=${installed.map((m) => m.id).join(" ")}`,
    `dir=${module.dir}`,
    `audit=${module.toolchain === "node"}`,
    `coverage=${module.coverage !== undefined}`,
    `image=${module.image !== undefined}`,
  ];
}

function main(argv) {
  const [verb, ...rest] = argv;
  const github = rest.includes("--github-output");
  const ids = rest.filter((arg) => !arg.startsWith("--"));
  const modules = presentModules().filter((m) => ids.length === 0 || ids.includes(m.id));
  const missing = ids.filter((id) => !modules.some((m) => m.id === id));
  if (missing.length > 0) throw new ModuleError(`no module named ${missing.join(", ")} here`);
  let lines;
  if (verb === "list") lines = modules.map((m) => `${m.id}\t${m.dir}\t${m.toolchain}`);
  else if (verb === "toolchains") lines = toolchainNeeds(modules);
  else if (verb === "job" && modules.length === 1 && ids.length === 1) lines = jobNeeds(modules[0], presentModules());
  else if (verb === "job") throw new ModuleError("job takes one module id");
  else throw new ModuleError(`unknown command "${verb ?? ""}": use list, toolchains or job`);
  if (github && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`modules: ${err instanceof ModuleError ? err.message : err.stack}`);
    process.exitCode = 2;
  }
}
