/**
 * A generated project's release is the updater's three-way-merge baseline. Changes to that output
 * must therefore advance the template version, including changes made by dependency update PRs.
 * Each revision's own initializer generates the supported presets, individual features and all
 * features; template-only changes that leave those outputs unchanged need no release.
 *
 *   node template/check-release.mjs --base v2.0.1 --head HEAD
 *
 * CI compares PR and merge-queue heads with their base, pushes with their previous head, and manual
 * runs with the previous commit. This script is template-only and disappears during initialization.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { compareVersions } from "../scripts/template-update.mjs";
import { ROOT } from "./init.mjs";
import { diffTrees } from "./release-notes.mjs";

export class ReleaseError extends Error {}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const manifestAt = (root, ref) => JSON.parse(git(root, ["show", `${ref}:template/features.json`]));
const commit = (root, ref) => {
  try {
    return git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new ReleaseError(`Cannot resolve release-check revision ${JSON.stringify(ref)}; fetch its history before checking.`);
  }
};

/** Event values reach Git as arguments, never as shell source. Missing PR/queue refs are an error. */
export function eventRefs(env) {
  if (env.EVENT === "pull_request") {
    if (!env.PR_BASE || !env.PR_HEAD) throw new ReleaseError("The pull request's base and head are required.");
    return { base: env.PR_BASE, head: env.PR_HEAD };
  }
  if (env.EVENT === "merge_group") {
    if (!env.QUEUE_BASE || !env.QUEUE_HEAD) throw new ReleaseError("The merge queue's base and head are required.");
    return { base: env.QUEUE_BASE, head: env.QUEUE_HEAD };
  }
  const head = env.SHA || "HEAD";
  const before = /^[0-9a-f]{40}$/.test(env.BEFORE ?? "") && !/^0+$/.test(env.BEFORE);
  return { base: env.EVENT === "push" && before ? env.BEFORE : `${head}^`, head };
}

/** Supported choices, including features not used in a preset. A missing choice is an empty tree. */
function choices(before, after) {
  const presets = [...new Set([...Object.keys(before.presets), ...Object.keys(after.presets)])];
  const features = [...new Set([...Object.keys(before.features), ...Object.keys(after.features)])];
  return [
    ...presets.map((name) => ({ name: `preset ${name}`, select: (m) => m.presets[name] })),
    ...features.map((id) => ({ name: `feature ${id}`, select: (m) => Object.hasOwn(m.features, id) ? [id] : undefined })),
    { name: "all features", select: (m) => Object.keys(m.features) },
  ];
}

function generate(root, selected, out) {
  if (selected === undefined) {
    mkdirSync(out);
    return;
  }
  try {
    execFileSync(process.execPath, ["template/init.mjs", "--features", selected.join(","), "--name", "release-demo", "--owner", "octo-org", "--repo", "release-demo", "--out", out], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new ReleaseError(`Cannot generate ${selected.join(", ") || "no features"}: ${String(err.stderr || err.message).trim()}`);
  }
}

/** Checks committed snapshots, without touching either source checkout or fetching the network. */
export function checkRelease({ root = ROOT, base, head = "HEAD" }) {
  if (!base) throw new ReleaseError("A base revision is required.");
  const refs = [commit(root, base), commit(root, head)];
  const [before, after] = refs.map((ref) => manifestAt(root, ref));
  for (const m of [before, after]) {
    if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) throw new ReleaseError(`Invalid template version ${JSON.stringify(m.version)}.`);
  }
  const direction = compareVersions(`v${after.version}`, `v${before.version}`);
  if (direction < 0) throw new ReleaseError(`Template version ${after.version} goes backwards from ${before.version}.`);
  if (direction > 0) {
    let published;
    try {
      published = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/v${after.version}^{commit}`]).trim();
    } catch {
      // A new candidate version has no tag yet; the post-merge workflow publishes it.
    }
    if (published && published !== refs[1]) {
      if (manifestAt(root, published).version !== after.version) throw new ReleaseError(`The existing v${after.version} tag declares a different version.`);
      try {
        checkRelease({ root, base: published, head: refs[1] });
      } catch (err) {
        throw new ReleaseError(`Version ${after.version} is already tagged and cannot be reused for different output. ${err.message}`);
      }
    }
    return { before: before.version, after: after.version, changed: [] };
  }

  const work = mkdtempSync(join(tmpdir(), "release-check-"));
  const changed = [];
  try {
    const clone = join(work, "source");
    // A private clone avoids worktree metadata changes in the checkout and races with other checks.
    git(root, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", root, clone]);
    const selections = choices(before, after);
    for (let side = 0; side < 2; side++) {
      git(clone, ["checkout", "--quiet", "--detach", refs[side]]);
      for (let i = 0; i < selections.length; i++) generate(clone, selections[i].select(side === 0 ? before : after), join(work, `${side}-${i}`));
    }
    selections.forEach(({ name }, i) => {
      const files = diffTrees(join(work, `0-${i}`), join(work, `1-${i}`));
      if (files.length) changed.push(`${name}: ${files.map(([status, path]) => `${status} ${path}`).join(", ")}`);
    });
    // Preset names and source identity are public inputs even when normalized generation looks alike.
    for (const field of ["identity", "presets"]) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changed.push(`template ${field} changed`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (changed.length) {
    throw new ReleaseError(`Generated output changed without advancing template version ${after.version}. Bump template/features.json and add release notes when required.\n${changed.join("\n")}`);
  }
  return { before: before.version, after: after.version, changed };
}

function main() {
  const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" } }, strict: true });
  const refs = values.base ? { base: values.base, head: values.head || "HEAD" } : eventRefs(process.env);
  const result = checkRelease({ ...refs, ...(values.head ? { head: values.head } : {}) });
  console.log(result.before === result.after
    ? `check-release: OK — version ${result.after} has unchanged generated output.`
    : `check-release: OK — ${result.before} → ${result.after}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`check-release: ${err.message}`);
    process.exitCode = 1;
  }
}
