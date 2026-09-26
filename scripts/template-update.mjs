/**
 * Brings the changes between two template releases into a project made from the template.
 *
 * A generated project keeps none of the template's history, so a later fix cannot be merged the usual
 * way. It keeps enough to recompute it, though: CHANGELOG.md records the template release it came from
 * and the features selected, and the project's name, owner and repository are its identity. So this
 * generates the project twice — as release A's init would have made it, and as release B's would — and
 * applies the difference with a three-way merge. Only what the template changed between A and B reaches
 * the project, already renamed and without the features it did not select. What the project changed
 * itself is kept; where both changed the same lines, the conflict is left in the working tree like any
 * merge conflict, for a person to resolve.
 *
 *   node scripts/template-update.mjs --to vX.Y.Z              # apply, then review with git diff
 *   node scripts/template-update.mjs --to latest              # the newest release
 *   node scripts/template-update.mjs --to vX.Y.Z --dry-run    # list what would change
 *   node scripts/template-update.mjs --add web                 # take a feature, at the current release
 *   node scripts/template-update.mjs --remove py-service       # give one up
 *
 * --add and --remove take comma-separated feature ids, may be combined with each other and with --to,
 * and change the selection by the same means: the "after" side is generated with the new selection.
 * The new selection is recorded in CHANGELOG.md beside the release, where the next update reads it.
 *
 * Needs git, network access to the template repository, and a clean working tree; it works on the
 * repository it is run in, from any directory of it. The name is read from package.json and owner and
 * repository from the `origin` remote; --name, --owner and --repo override them, and --template points at
 * another copy of the template (a path or URL). Each release's tag is printed with the commit it names
 * before that release's init runs, since that init is code this runs.
 *
 * Exit 0 applied cleanly or nothing to do · 1 applied with conflicts · 2 cannot run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export class UpdateError extends Error {}

const VERSION = /^v\d+\.\d+\.\d+$/;
// Written by init, and by this script.
const ORIGIN = /^- (Initialized from|Updated to) \[[^\]\s]+ (v\d+\.\d+\.\d+)\]\((https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/tag\/v\d+\.\d+\.\d+\)(?: with (.+?))?\.?$/gm;

const featureList = (text) => (text === "no features" ? [] : text.split(",").map((f) => f.trim()));

/**
 * What the project's CHANGELOG says about where it came from: the release it is on, and the features it
 * has. Init names the features; an update that changed them names them again, and one that did not
 * leaves them out.
 */
export function readOrigin(changelog) {
  const lines = [...changelog.matchAll(ORIGIN)];
  if (!lines.some((m) => m[1] === "Initialized from")) {
    throw new UpdateError('CHANGELOG.md has no "Initialized from" line, so the template release this project came from is unknown.');
  }
  // Updates only move forward, so the newest release is the highest version. Position proves nothing
  // across versions: release-please moves sections around. Within one version, which happens when the
  // selection changes without a release move, the first line wins, because every line is written
  // directly under the heading, above the ones before it.
  const newest = (candidates) => candidates.reduce((best, line) => (compareVersions(line[2], best[2]) > 0 ? line : best));
  const current = newest(lines);
  const selection = newest(lines.filter((m) => m[4] !== undefined));
  return { version: current[2], url: current[3], features: featureList(selection[4]) };
}

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.slice(1).split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Records the update beside the line init wrote, so the next update knows where to start. `features` is
 * given only when the selection changed, and is then written as init writes it.
 */
export function recordUpdate(changelog, url, to, features) {
  const heading = "## [Unreleased]";
  const repo = url.split("/").at(-1);
  const selection = features === undefined ? "" : ` with ${features.join(", ") || "no features"}`;
  const line = `- Updated to [${repo} ${to}](${url}/releases/tag/${to})${selection}.`;
  if (!changelog.includes(heading)) return `${changelog.trimEnd()}\n\n${heading}\n\n${line}\n`;
  return changelog.replace(heading, `${heading}\n\n${line}`);
}

/** Owner and repository from a GitHub remote URL, or null. */
export function remoteIdentity(url) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

const git = (cwd, args, options = {}) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
/** The line of an error worth showing: git's own message where there is one, not the command it ran. */
const firstLine = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];

/** Runs a template release's own init, exactly as a new project would have. */
function generate(templateDir, identity, features, out) {
  const selection = features.length === 0 ? ["--preset", "minimal"] : ["--features", features.join(",")];
  const args = ["template/init.mjs", "--name", identity.name, "--owner", identity.owner, "--repo", identity.repo, ...selection, "--out", out];
  const result = spawnSync(process.execPath, args, { cwd: templateDir, encoding: "utf8" });
  if (result.status !== 0) throw new UpdateError(`init at ${templateDir} failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1)}`);
}

/** Replaces a repository's tracked content with a directory's, as one commit. */
function commitTree(repo, from, message) {
  for (const entry of readdirSync(repo)) if (entry !== ".git") rmSync(join(repo, entry), { recursive: true, force: true });
  cpSync(from, repo, { recursive: true });
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=template-update", "-c", "user.email=template-update@localhost", "commit", "-q", "--allow-empty", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/** The highest release tag at `source`, a path or URL. */
function latestRelease(source) {
  let listed;
  try {
    listed = execFileSync("git", ["ls-remote", "--tags", "--refs", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new UpdateError(`cannot list the releases of ${source}: ${firstLine(err)}`);
  }
  const tags = listed.split("\n").map((line) => line.split("refs/tags/")[1]).filter((tag) => VERSION.test(tag ?? ""));
  if (tags.length === 0) throw new UpdateError(`${source} has no release tag such as v1.10.0.`);
  return tags.reduce((best, tag) => (compareVersions(tag, best) > 0 ? tag : best));
}

export function update({ project, to, add = [], remove = [], dryRun = false, template, owner, repo, name, log = console.log }) {
  const changesSelection = add.length > 0 || remove.length > 0;
  if (to === undefined && !changesSelection) throw new UpdateError("Nothing to do: pass --to with a release, or --add or --remove with features.");
  if (to !== undefined && to !== "latest" && !VERSION.test(to)) throw new UpdateError(`--to must be a release tag such as v1.10.0, or latest, got "${to}".`);
  if (git(project, ["status", "--porcelain"]).trim() !== "") throw new UpdateError("The working tree has uncommitted changes. Commit or stash them first, so the update can be reviewed and undone on its own.");

  const changelogPath = join(project, "CHANGELOG.md");
  if (!existsSync(changelogPath)) throw new UpdateError("CHANGELOG.md is missing; it records which template release this project came from.");
  const changelog = readFileSync(changelogPath, "utf8");
  const origin = readOrigin(changelog);
  const source = template ?? `${origin.url}.git`;
  if (to === "latest") to = latestRelease(source);
  // Without --to, a selection change happens at the release the project is already on.
  to ??= origin.version;
  for (const id of add) if (origin.features.includes(id)) throw new UpdateError(`${id} is already one of this project's features: ${origin.features.join(", ")}.`);
  for (const id of remove) if (!origin.features.includes(id)) throw new UpdateError(`${id} is not one of this project's features: ${origin.features.join(", ") || "none"}.`);
  if (origin.version === to && !changesSelection) {
    log(`template-update: already at ${to}.`);
    return { status: "current" };
  }
  // Applied backwards, the difference would quietly undo later releases, and the recorded version (the
  // highest one listed) would still claim the newer release. Updates only move forward.
  if (compareVersions(to, origin.version) < 0) {
    throw new UpdateError(`${to} is older than ${origin.version}, the release this project is on. template-update only moves forward.`);
  }

  const packageJson = join(project, "package.json");
  name ??= existsSync(packageJson) ? JSON.parse(readFileSync(packageJson, "utf8")).name : undefined;
  let fromRemote = null;
  try {
    fromRemote = remoteIdentity(git(project, ["remote", "get-url", "origin"]));
  } catch {
    // No origin remote; --owner and --repo must say it.
  }
  const identity = { name, owner: owner ?? fromRemote?.owner, repo: repo ?? fromRemote?.repo };
  if (!identity.name || !identity.owner || !identity.repo) {
    throw new UpdateError("Cannot tell this project's name, owner and repository. The name comes from package.json, and owner and repository from a GitHub origin remote; pass --name, --owner or --repo for what is missing.");
  }

  const work = mkdtempSync(join(tmpdir(), "template-update-"));
  try {
    log(`template-update: ${origin.version} → ${to} from ${source}, features: ${origin.features.join(", ") || "none"}`);
    try {
      git(work, ["clone", "--quiet", "--no-checkout", source, "template"]);
    } catch (err) {
      throw new UpdateError(`cannot fetch the template from ${source}: ${firstLine(err)}`);
    }
    const clone = join(work, "template");
    const versions = [...new Set([origin.version, to])];
    for (const version of versions) {
      let sha;
      try {
        sha = git(clone, ["rev-parse", "--verify", "--quiet", `refs/tags/${version}^{commit}`]).trim();
      } catch {
        throw new UpdateError(`There is no release ${version} in ${source}.`);
      }
      // Its init runs next: say exactly which code that is.
      log(`template-update: ${version} is commit ${sha}`);
    }
    // Feature ids are the target release's to define: a feature added later exists only from then on.
    const manifestAt = (version) => JSON.parse(git(clone, ["show", `${version}:template/features.json`]));
    const known = Object.keys(manifestAt(to).features);
    const unknown = add.filter((id) => !known.includes(id));
    if (unknown.length > 0) throw new UpdateError(`${to} defines no feature ${unknown.join(", ")}. It defines: ${known.join(", ")}.`);
    const features = changesSelection ? known.filter((id) => (origin.features.includes(id) || add.includes(id)) && !remove.includes(id)) : origin.features;
    if (changesSelection) log(`template-update: features ${origin.features.join(", ") || "none"} → ${features.join(", ") || "none"}`);

    for (const version of versions) git(clone, ["worktree", "add", "--quiet", "--detach", join(work, `at-${version}`), version]);
    const pair = join(work, "pair");
    mkdirSync(pair);
    git(pair, ["init", "-q"]);
    const sides = [
      ["before", origin.version, origin.features],
      ["after", to, features],
    ];
    const shas = sides.map(([side, version, selection]) => {
      generate(join(work, `at-${version}`), identity, selection, join(work, `gen-${side}`));
      return commitTree(pair, join(work, `gen-${side}`), `template ${version} ${side}`);
    });
    const [before, after] = shas;
    // The CHANGELOG is the project's own; init's origin line in it is replaced by the "Updated to" line.
    let scope = ["--", ".", ":(exclude)CHANGELOG.md"];
    const entries = git(pair, ["diff", "--no-renames", "--name-status", before, after, ...scope]).trim().split("\n").filter(Boolean);
    // A change to a file the project has since deleted is the project's decision standing; skip it
    // rather than let one missing file make git apply refuse the whole patch.
    // Each line is "<status>\t<path>"; a path may itself contain a tab, so split at the first one only.
    const parsed = entries.map((e) => [e.slice(0, e.indexOf("\t")), e.slice(e.indexOf("\t") + 1)]);
    const skipped = parsed.filter(([kind, path]) => kind !== "A" && !existsSync(join(project, path))).map(([, path]) => path);
    scope = [...scope, ...skipped.map((path) => `:(exclude)${path}`)];
    let files = parsed.filter(([, path]) => !skipped.includes(path)).map(([kind, path]) => `${kind} ${path}`);
    if (skipped.length > 0) log(`template-update: skipped ${skipped.length} file(s) this project removed: ${skipped.join(", ")}`);

    // git apply --3way cannot merge a deletion with an edit, or an addition with a file already there:
    // it stops with the rest of the patch half applied. So both are refused, by path, before anything is.
    const generated = (path) => readFileSync(join(work, "gen-before", path));
    const edited = parsed.filter(([kind, path]) => kind === "D" && existsSync(join(project, path)) && !readFileSync(join(project, path)).equals(generated(path)));
    // A file the project already has exactly as the release adds it needs nothing, and is left out of the patch.
    const same = parsed.filter(([kind, path]) => kind === "A" && existsSync(join(project, path)) && readFileSync(join(project, path)).equals(readFileSync(join(work, "gen-after", path))));
    const occupied = parsed.filter(([kind, path]) => kind === "A" && existsSync(join(project, path)) && !same.some(([, p]) => p === path));
    scope = [...scope, ...same.map(([, path]) => `:(exclude)${path}`)];
    files = files.filter((line) => !same.some(([, path]) => line === `A ${path}`));
    // A file of the project's own inside a feature being removed would be left behind in a directory the
    // feature no longer owns, so it is named as well rather than kept or deleted silently.
    const removedPaths = remove.flatMap((id) => manifestAt(origin.version).features[id]?.paths ?? []);
    const keptPaths = features.flatMap((id) => manifestAt(to).features[id]?.paths ?? []);
    const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
    const own = git(project, ["ls-files", "-z"]).split("\0").filter(Boolean)
      .filter((path) => removedPaths.some((dir) => inside(path, dir)) && !keptPaths.some((dir) => inside(path, dir)))
      .filter((path) => !existsSync(join(work, "gen-before", path)));
    const blocked = [
      ...edited.map(([, path]) => `${path} (this project changed it, and the update deletes it)`),
      ...occupied.map(([, path]) => `${path} (the update adds it, and this project already has one)`),
      ...own.map((path) => `${path} (this project's own file, inside a feature being removed)`),
    ];
    if (blocked.length > 0) {
      throw new UpdateError(`the update cannot be applied over these files:\n  ${blocked.join("\n  ")}\nMove them out of the way, or delete them, then run this again.`);
    }

    const record = () => recordUpdate(changelog, origin.url, to, changesSelection ? features : undefined);
    if (files.length === 0) {
      log(`template-update: nothing in ${to} changes a file this project has.`);
      if (!dryRun) writeFileSync(changelogPath, record());
      return { status: dryRun ? "dry-run" : "applied", conflicts: [], changed: [], skipped, features, to };
    }
    if (dryRun) {
      log(`template-update: ${files.length} file(s) would change:\n  ${files.join("\n  ")}`);
      return { status: "dry-run", changed: files, features };
    }

    // The objects must be in the project for a three-way merge to find each file's common ancestor.
    git(project, ["fetch", "--quiet", "--no-tags", pair, `+HEAD:refs/template-update/after`]);
    const patch = git(pair, ["diff", "--no-renames", "--binary", "--full-index", before, after, ...scope]);
    const applied = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: project, input: patch, encoding: "utf8" });
    git(project, ["update-ref", "-d", "refs/template-update/after"]);
    const conflicts = git(project, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n").filter(Boolean);
    if (applied.status !== 0 && conflicts.length === 0) {
      throw new UpdateError(`git apply could not use the patch: ${applied.stderr.trim().split("\n").at(-1)}`);
    }
    // A removed feature's directory can still hold what setup installed or a build wrote, all ignored, and
    // a module counts as present while its directory exists. The tree was clean when this started, so
    // once no tracked file is left in one, nothing in it is the project's; it goes whole, as init does.
    const emptied = [...new Set(removedPaths)]
      .filter((dir) => !keptPaths.some((kept) => inside(dir, kept) || inside(kept, dir)))
      .filter((dir) => existsSync(join(project, dir)) && git(project, ["ls-files", "--", dir]).trim() === "");
    for (const dir of emptied) rmSync(join(project, dir), { recursive: true, force: true });
    if (emptied.length > 0) log(`template-update: removed ${emptied.join(", ")} with the ignored files left in it (dependencies, build output)`);
    // Written even when there are conflicts: the record is part of the same uncommitted change, so
    // reverting the update removes it too, and committing the resolved update keeps it.
    writeFileSync(changelogPath, record());
    log(`template-update: ${files.length} file(s) changed.${conflicts.length ? ` Resolve ${conflicts.length} conflict(s): ${conflicts.join(", ")}` : ""}`);
    log("Next: git diff to review, node scripts/setup.mjs, node scripts/verify.mjs, then commit.");
    return { status: "applied", conflicts, changed: files, skipped, features, to };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      add: { type: "string" },
      remove: { type: "string" },
      "dry-run": { type: "boolean" },
      template: { type: "string" },
      owner: { type: "string" },
      repo: { type: "string" },
      name: { type: "string" },
    },
  });
  const ids = (list) => (list ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  try {
    // The repository this runs in, from wherever in it: its CHANGELOG and package.json are at the root.
    const project = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const result = update({
      project,
      to: values.to,
      add: ids(values.add),
      remove: ids(values.remove),
      dryRun: values["dry-run"],
      template: values.template,
      owner: values.owner,
      repo: values.repo,
      name: values.name,
    });
    return result.conflicts?.length ? 1 : 0;
  } catch (err) {
    // Exit 1 means "applied with conflicts", so anything that stops the update before that is 2.
    console.error(`template-update: ${err instanceof UpdateError ? err.message : `could not run: ${firstLine(err)}`}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
