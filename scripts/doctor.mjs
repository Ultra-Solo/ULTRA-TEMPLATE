/**
 * The doctor: one read-only command that reports, as JSON, what this checkout needs before its checks
 * can run — the Node it pins, git and the state of the working tree, each module's toolchain, the
 * files it commits and the dependencies it installs, the pinned tools its checks run, and where the
 * project came from — offline, changing nothing (ADR-0027).
 *
 * A check is `pass`, `fail`, `unknown` or `not-applicable`. What this machine cannot decide — git
 * absent, a tool not on PATH, the network — is `unknown`, never a silent pass: a pass here has to
 * predict CI, and only CI can decide those. The exit code says which: 0 nothing failed, 1 something
 * failed, 2 the doctor itself could not run.
 *
 *   node scripts/doctor.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { available, loadModules, nodeVersionProblem, ROOT, TOOLCHAINS } from "./modules.mjs";
import { PROVENANCE_FILE, readProvenance, SourceError } from "./template-source.mjs";
import { readOrigin, UpdateError } from "./template-update.mjs";
import { installedVersion, loadTools, localTools, validateTools, versionProblem } from "./tools.mjs";

const check = (id, status, detail) => ({ id, status, detail });

/**
 * The working tree of `root`: "clean", "dirty", or null when it is not a git repository — a generated
 * project is not necessarily one, so that is a state to report, not an error to throw.
 */
function treeState(root) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() === "" ? "clean" : "dirty";
}

/** What the doctor can say about one pinned tool: the pinned version on PATH, another version, or nothing it can check. */
function pinnedTool(name, tools, toolVersion) {
  const found = toolVersion(name, tools);
  if (found === null) {
    return tools[name].versionCommand
      ? check(`pinned-tool:${name}`, "unknown", `${name} is not on PATH; node scripts/tools.mjs install --local installs it.`)
      : check(
          `pinned-tool:${name}`,
          "unknown",
          `scripts/tools/tools.json names no version command for ${name}, so the version on PATH cannot be checked.`,
        );
  }
  const wrong = versionProblem(name, found, tools);
  return wrong !== null
    ? check(`pinned-tool:${name}`, "fail", wrong)
    : check(`pinned-tool:${name}`, "pass", `${name} ${found} is on PATH, the pinned version.`);
}

/**
 * Where this project came from, and how an update must be told: the provenance record init writes, or
 * the CHANGELOG line a legacy project keeps. The `baseline` says which — null when none can be read.
 */
function templateSource(root) {
  let record;
  try {
    record = readProvenance(root);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    return { check: check("template-source", "fail", err.message), baseline: null };
  }
  if (record !== null) {
    return {
      check: check(
        "template-source",
        "pass",
        `${PROVENANCE_FILE} records the template at ${record.source.version} (commit ${record.source.commit}).`,
      ),
      baseline: "provenance",
    };
  }
  const changelog = join(root, "CHANGELOG.md");
  if (!existsSync(changelog)) {
    return {
      check: check(
        "template-source",
        "fail",
        `neither ${PROVENANCE_FILE} nor CHANGELOG.md records where this project came from, so no template update can be computed.`,
      ),
      baseline: null,
    };
  }
  try {
    const origin = readOrigin(readFileSync(changelog, "utf8"));
    return {
      check: check(
        "template-source",
        "pass",
        `legacy baseline: CHANGELOG.md records ${origin.version}; template-update needs --legacy-commit to move it.`,
      ),
      baseline: "legacy",
    };
  } catch (err) {
    if (!(err instanceof UpdateError)) throw err;
    return { check: check("template-source", "fail", `no ${PROVENANCE_FILE} records this project, and ${err.message}`), baseline: null };
  }
}

/**
 * The report: every check this checkout needs before its checks can run, as one JSON object. `has` and
 * `toolVersion` are how the tests decide fail paths deterministically; the defaults ask the machine.
 */
export function diagnose(root = ROOT, { has = available, toolVersion = installedVersion } = {}) {
  const checks = [];

  const nodeFile = join(root, ".node-version");
  if (!existsSync(nodeFile)) {
    checks.push(
      check("node-version", "unknown", "no .node-version is pinned here, so the Node major version this checkout runs on is not stated."),
    );
  } else {
    const problem = nodeVersionProblem(readFileSync(nodeFile, "utf8"));
    checks.push(
      problem === null
        ? check("node-version", "pass", `this is Node ${process.versions.node}, the major version .node-version pins.`)
        : check("node-version", "fail", problem),
    );
  }

  const gitPresent = has("git", ["--version"]);
  checks.push(
    gitPresent
      ? check("git-present", "pass", "git is on PATH.")
      : check("git-present", "fail", "git is not on PATH, so the working tree cannot be read."),
  );
  if (!gitPresent) {
    checks.push(check("git-clean", "unknown", "git is not on PATH, so the working tree cannot be read."));
  } else {
    const tree = treeState(root);
    checks.push(
      tree === "clean"
        ? check("git-clean", "pass", "the working tree is clean, so template-update can run.")
        : tree === "dirty"
          ? check(
              "git-clean",
              "fail",
              "the working tree has uncommitted changes; template-update refuses to run until they are committed or stashed.",
            )
          : check("git-clean", "unknown", "this directory is not a git repository, so there is no working tree to keep clean."),
    );
  }

  const { modules, problems } = loadModules(root);
  checks.push(
    problems.length > 0
      ? check("modules", "fail", problems.join(" "))
      : modules.length === 0
        ? check("modules", "pass", "no modules are present, so no toolchain is needed.")
        : check("modules", "pass", `${modules.length} module(s): ${modules.map((module) => module.id).join(", ")}.`),
  );

  for (const module of modules) {
    const tool = TOOLCHAINS[module.toolchain];
    checks.push(
      has(tool.command, tool.probe)
        ? check(`module:${module.id}:toolchain`, "pass", `${tool.command} is on PATH.`)
        : check(
            `module:${module.id}:toolchain`,
            "fail",
            `${tool.command} is not on PATH, which every check of a ${module.toolchain} module runs.`,
          ),
    );
    const committed = [tool.manifest, tool.lockfile].filter((name) => name !== null);
    const missing = committed.filter((name) => !existsSync(join(root, module.dir, name)));
    checks.push(
      missing.length === 0
        ? check(
            `module:${module.id}:files`,
            "pass",
            `${committed.join(" and ")} ${committed.length === 1 ? "is" : "are"} present in ${module.dir}.`,
          )
        : check(
            `module:${module.id}:files`,
            "fail",
            `${module.dir} is missing ${missing.join(" and ")}, which a ${module.toolchain} module commits.`,
          ),
    );
    checks.push(
      tool.installed === null
        ? check(
            `module:${module.id}:installed`,
            "not-applicable",
            `the ${module.toolchain} toolchain installs no directory inside the module.`,
          )
        : existsSync(join(root, module.dir, tool.installed))
          ? check(`module:${module.id}:installed`, "pass", `${tool.installed} is installed in ${module.dir}.`)
          : check(
              `module:${module.id}:installed`,
              "fail",
              `${tool.installed} is not installed in ${module.dir}; run node scripts/setup.mjs.`,
            ),
    );
  }

  const toolsFile = join(root, "scripts", "tools", "tools.json");
  if (!existsSync(toolsFile)) {
    checks.push(check("pinned-tools", "not-applicable", "no scripts/tools/tools.json is present, so no tool is pinned here."));
  } else {
    let tools = null;
    let problem = null;
    try {
      tools = loadTools(toolsFile);
      problem = validateTools(tools).join(" ") || null;
    } catch (err) {
      problem = err.message;
    }
    if (problem !== null) {
      checks.push(check("pinned-tools", "fail", `scripts/tools/tools.json cannot be used: ${problem}`));
    } else {
      const names = localTools([...new Set(modules.map((module) => module.toolchain))], tools);
      checks.push(
        names.length === 0
          ? check("pinned-tools", "pass", "no pinned tool is needed here.")
          : check("pinned-tools", "pass", `${names.length} pinned tool(s) this checkout needs: ${names.join(", ")}.`),
      );
      for (const name of names) checks.push(pinnedTool(name, tools, toolVersion));
    }
  }

  if (existsSync(join(root, "template", "features.json"))) {
    checks.push(check("template-source", "not-applicable", "this checkout is the template itself, which no provenance record describes."));
    checks.push(check("update", "not-applicable", "the template does not update from itself."));
  } else {
    const source = templateSource(root);
    checks.push(source.check);
    checks.push(
      source.baseline === null
        ? check("update", "not-applicable", "no template baseline to compare against.")
        : check("update", "unknown", "needs the network; run node scripts/template-update.mjs --check."),
    );
  }

  return {
    schema: 1,
    project: { root, node: process.versions.node, modules: modules.map((module) => module.id) },
    checks,
  };
}

/**
 * Prints the report and returns the exit code: 0 no check failed, 1 a check failed, 2 the doctor could
 * not run. It takes no arguments, because it reports on the checkout it runs in.
 */
export function main(argv = process.argv.slice(2), { root = ROOT, has, toolVersion, log = console.log } = {}) {
  if (argv.length > 0) {
    console.error("doctor: takes no arguments; it reports on the checkout it runs in.");
    return 2;
  }
  const report = diagnose(root, { has, toolVersion });
  log(JSON.stringify(report, null, 2));
  return report.checks.some((entry) => entry.status === "fail") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`doctor: could not run: ${err instanceof Error ? err.stack : err}`);
    process.exitCode = 2;
  }
}
