/**
 * Release notes for a template release, written for the people who will take it into a project.
 *
 * GitHub's generated notes list pull request titles, which say what changed in this repository. An
 * adopter needs something else: which files change in a project made from the template. So this
 * generates a project from every preset at both releases, with that release's own init, and compares
 * the two — what template-update.mjs does to build its patch. The notes then list what an update
 * actually applies, which a diff of the template tree cannot tell: a change inside a marker block
 * reaches only the presets that keep that block, and a file whose ownership moved is deleted from the
 * presets that no longer own it while its contents never changed at all.
 *
 *   node template/release-notes.mjs --to v1.4.1                 # since the previous release tag
 *   node template/release-notes.mjs --to v1.4.1 --from v1.3.0
 *
 * A file list says what changes, not what an adopter must do about it: which new check can turn their
 * build red, which file to merge by hand. So a minor or major release carries notes of its own,
 * template/notes/v<version>.md, written with the change, and they come first, under "What you need to
 * know". A test fails a patch-0 version without them (NOTES_DIR).
 *
 * Template-only: init deletes it, with the rest of template/.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT } from "./init.mjs";

/** Where a release's notes for adopters live, as v<version>.md. Template-only, like everything here. */
export const NOTES_DIR = "template/notes";

/** The first release written with notes; the releases before it were published without any. */
export const NOTES_SINCE = "1.2.0";

/** Whether version `a` comes before version `b`. */
const older = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const at = x.findIndex((n, i) => n !== y[i]);
  return at !== -1 && x[at] < y[at];
};

/** The notes file a version must have: every minor and major release, which is every patch-0 version. */
export const requiredNotes = (version) => (/^\d+\.\d+\.0$/.test(version) && !older(version, NOTES_SINCE) ? `${NOTES_DIR}/v${version}.md` : null);

// The same at both releases, so the identity cancels out of the comparison.
const IDENTITY = ["--name", "demo-app", "--owner", "octo-org"];

/** Every file under a directory, as paths relative to it, with forward slashes. */
export function walk(dir, base = "") {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(dir, join(base, entry.name)) : [join(base, entry.name).split(sep).join("/")]);
}

/**
 * What changed between two generated projects. CHANGELOG.md is left out for the reason
 * template-update leaves it out: init writes the release a project came from into that file, so it
 * differs in every release by definition, and the update rewrites the line itself. Provenance is
 * recorded separately for the same reason; its source commit also changes for template-only edits.
 */
export function diffTrees(before, after) {
  const [a, b] = [new Set(walk(before)), new Set(walk(after))];
  return [...new Set([...a, ...b])].sort()
    .filter((path) => !["CHANGELOG.md", ".template-provenance.json"].includes(path))
    .flatMap((path) => {
      if (!a.has(path)) return [["A", path]];
      if (!b.has(path)) return [["D", path]];
      const beforeContent = readFileSync(join(before, path)).toString().replace(/\r\n/g, "\n");
      const afterContent = readFileSync(join(after, path)).toString().replace(/\r\n/g, "\n");
      return beforeContent === afterContent ? [] : [["M", path]];
    });
}

/**
 * One section per set of presets that receive the same files, in the order the presets were given.
 * A preset that receives nothing is dropped, and presets whose lists are identical share a section —
 * the usual case, since most releases change the same files for everyone.
 */
export function groupByPreset(perPreset) {
  const groups = new Map();
  for (const [preset, entries] of perPreset) {
    const files = entries.map(([status, path]) => `${status} ${path}`);
    if (files.length === 0) continue;
    const key = files.join("\n");
    if (!groups.has(key)) groups.set(key, { presets: [], files });
    groups.get(key).presets.push(preset);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    title: group.presets.length === perPreset.length ? "Every preset" : group.presets.join(", "),
  }));
}

/**
 * The first release has nothing to compare against, so it says what the template is for instead of
 * what changed. `from` is null exactly then: no tag matches `v*` yet.
 */
function firstRelease(pullRequests) {
  const lines = [
    "The first release of this template.",
    "",
    "## Starting a project",
    "",
    'Create a repository from the template with **Use this template**, clone it, then:',
    "",
    "```bash",
    "node template/init.mjs --list",
    "node template/init.mjs",
    "```",
    "",
    "Init keeps the features you select, deletes the rest, takes the repository's own identity, and deletes itself. Then `node scripts/setup.mjs && node scripts/verify.mjs`.",
    "",
  ];
  if (pullRequests.trim() !== "") lines.push(pullRequests.trim(), "");
  return lines.join("\n");
}

export function render({ to, from, groups, templateOnly = [], addedPresets = [], pullRequests = "", notes = "" }) {
  if (from === null) return firstRelease(pullRequests);
  const lines = [`Changes since ${from}.`, ""];
  if (notes.trim() !== "") lines.push("## What you need to know", "", notes.trim(), "");
  lines.push("## What changes in generated projects", "");
  lines.push(groups.length === 0
    ? "Nothing: no file changes in a project made from any preset."
    : "Every preset was generated at both releases, with that release's own init, and compared. This is what an update applies.", "");
  for (const { title, files } of groups) {
    lines.push(`### ${title}`, "", ...files.map((f) => `- \`${f}\``), "");
  }
  if (addedPresets.length > 0) lines.push(`New in this release: the preset(s) ${addedPresets.join(", ")}.`, "");
  lines.push(
    "## Taking it into a project",
    "",
    "```bash",
    `node scripts/template-update.mjs --to ${to} --dry-run`,
    `node scripts/template-update.mjs --to ${to}`,
    "```",
    "",
  );
  if (templateOnly.length > 0) {
    lines.push(
      "## Reaches no project",
      "",
      "These changed in the template and appear in no generated project: template-only files, and shared files whose change lies inside a `template` block.",
      "",
      ...templateOnly.map((f) => `- \`${f}\``),
      "",
    );
  }
  if (pullRequests.trim() !== "") lines.push(pullRequests.trim(), "");
  return lines.join("\n");
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** A project as one release's own init would have made it. */
function generate(templateDir, preset, out) {
  const manifest = JSON.parse(readFileSync(join(templateDir, "template/features.json"), "utf8"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: templateDir, encoding: "utf8" }).trim();
  const sourceArgs = manifest.provenanceSchema === 1 ? ["--source", templateDir, "--source-commit", sha] : [];
  const result = spawnSync(process.execPath, ["template/init.mjs", ...sourceArgs, ...IDENTITY, "--preset", preset, "--out", out], { cwd: templateDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`init at ${templateDir} failed for preset ${preset}: ${(result.stderr || result.stdout).trim().split("\n").at(-1)}`);
  }
  return out;
}

/**
 * GitHub's own list of merged pull requests, appended so the notes carry both views. The tag does not
 * exist yet when this runs, so the API needs the commit it will point at; `from` is null on a first
 * release, and GitHub then goes back to the start of the history by itself.
 */
function mergedPullRequests(repo, to, from) {
  if (!repo) return "";
  const fields = [`tag_name=${to}`, `target_commitish=${git("rev-parse", "HEAD")}`, ...(from === null ? [] : [`previous_tag_name=${from}`])];
  return execFileSync("gh", ["api", `repos/${repo}/releases/generate-notes`, ...fields.flatMap((f) => ["-f", f]), "--jq", ".body"], { encoding: "utf8" });
}

function main() {
  const { values } = parseArgs({ options: { to: { type: "string" }, from: { type: "string" }, repo: { type: "string" } } });
  if (!/^v\d+\.\d+\.\d+$/.test(values.to ?? "")) throw new Error(`--to must be a version tag such as v1.4.1, got "${values.to ?? ""}"`);
  // No tag matching v* means this is the first release: there is nothing to compare it against, and
  // git describe fails rather than saying so.
  let previous = null;
  try {
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD");
  } catch {
    previous = null;
  }
  const from = values.from ?? previous;
  if (from === null) {
    process.stdout.write(render({ to: values.to, from, groups: [], pullRequests: mergedPullRequests(values.repo, values.to, null) }));
    return;
  }
  const entries = git("diff", "--no-renames", "--name-status", from, "HEAD").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)]);

  const work = mkdtempSync(join(tmpdir(), "release-notes-"));
  const worktrees = [];
  try {
    // HEAD gets a worktree of its own rather than being read from this checkout: init --out reads the
    // tracked files as they are on disk, so an uncommitted change here would reach the notes.
    const [before, after] = ["before", "after"].map((label, i) => {
      const dir = join(work, label);
      git("worktree", "add", "--quiet", "--detach", dir, [from, "HEAD"][i]);
      worktrees.push(dir);
      return dir;
    });
    const presets = (dir) => Object.keys(JSON.parse(readFileSync(join(dir, "template/features.json"), "utf8")).presets);
    const known = new Set(presets(before));
    const addedPresets = presets(after).filter((preset) => !known.has(preset));
    const perPreset = presets(after).filter((preset) => known.has(preset)).map((preset) => [
      preset,
      diffTrees(generate(before, preset, join(work, `before-${preset}`)), generate(after, preset, join(work, `after-${preset}`))),
    ]);

    // What changed in the template but reaches no project: both the template-only paths and a shared
    // file whose change lies entirely inside its `template` blocks, without having to tell them apart.
    const reaching = new Set(perPreset.flatMap(([, diff]) => diff.map(([, path]) => path)));
    const templateOnly = entries.filter(([, path]) => !reaching.has(path)).map(([status, path]) => `${status} ${path}`);

    const pullRequests = mergedPullRequests(values.repo, values.to, from);
    // Read from the release's own tree, as everything else here is.
    const notesFile = join(after, NOTES_DIR, `${values.to}.md`);
    const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
    process.stdout.write(render({ to: values.to, from, groups: groupByPreset(perPreset), templateOnly, addedPresets, pullRequests, notes }));
  } finally {
    for (const dir of worktrees) {
      try {
        git("worktree", "remove", "--force", dir);
      } catch {
        // Already gone, or never added; the directory goes with the rest below either way.
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
