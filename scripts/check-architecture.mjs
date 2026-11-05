/**
 * The architecture model, held to the modules that are really here.
 *
 * AGENTS.md asks for the model to change in the same pull request as the structure it describes, and a
 * model nobody compares with the code drifts into a picture of a system that no longer exists. So each
 * module present must have exactly one element in the model that links to its README. The model's own
 * module is exempt: it is the picture, not something in it. ADR-0048 amended the other half of this
 * rule — that every README link names a module — because it is held repo-wide below instead: any link
 * to a file that is not here fails checkDrawn, README or not.
 *
 * ADR-0046 drew the chassis scripts, ADR-0047 every file under scripts/ and every workflow in
 * .github/workflows/, and ADR-0048 the rest of the repository: every tracked file outside the module
 * directories and the ADR record log must be the target of some model link, and every model link —
 * wherever it points — must name a file that is here. The module directories are drawn as one element
 * each by checkModel above; the ADR record log is represented by the `adr` element linking its index
 * and template seed, because template/clean.mjs drops the records themselves from a generated project.
 * Feature-owned files carry their feature's marker in the model, so a generated project keeps the
 * link exactly when it keeps the file.
 *
 *   node scripts/check-architecture.mjs <model-dir>     # from the module that holds the model
 *
 * The model's `link <path>` lines are read as text, relative to the file they are in; nothing else in
 * the model is parsed. Exit 0 agrees · 1 disagrees · 2 the model cannot be read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { presentModules, ROOT } from "./modules.mjs";

const README = "README.md";

/** The repository-relative targets of every `link` line in the model's files, as {file, line, target}. */
export function modelLinks(files) {
  return files.flatMap(({ path, text }) =>
    text.split(/\r?\n/).flatMap((line, i) => {
      const link = /^\s*link\s+(\S+)/.exec(line);
      return link && !/^[a-z]+:\/\//.test(link[1])
        ? [{ file: path, line: i + 1, target: posix.normalize(posix.join(posix.dirname(path), link[1])) }]
        : [];
    }),
  );
}

/** Every way the model and the modules disagree, or an empty list. `modelDir` is the model's own module. */
export function checkModel(modules, links, modelDir) {
  const problems = [];
  const holdsModel = (m) => modelDir === m.dir || modelDir.startsWith(`${m.dir}/`);
  const described = modules.filter((m) => !holdsModel(m));
  for (const module of described) {
    const readme = `${module.dir}/${README}`;
    const found = links.filter((link) => link.target === readme);
    if (found.length === 0)
      problems.push(
        `${module.id} (${module.dir}) is here, but no element of the model links to ${readme}. Add one in the same change as the module.`,
      );
    if (found.length > 1)
      problems.push(
        `${module.id} has ${found.length} elements linking to ${readme} (${found.map((l) => `${l.file}:${l.line}`).join(", ")}); a module is one element.`,
      );
  }
  return problems;
}

// The ADR record log is represented by the model's `adr` element linking its index and template seed,
// not file by file: template/clean.mjs drops every record from a generated project, so a per-record
// link could never hold there. Mirror its patterns here; this checker must not import from template/.
const ADR_RECORD = /^docs\/adr\/\d{4}-[^/]+\.md$/;
const ADR_SEEDS = new Set(["docs/adr/README.md", "docs/adr/0000-template.md"]);
// Written by template/init.mjs into every generated project (ADR-0023); not template content, so never drawn.
const GENERATED = new Set([".template-provenance.json"]);

/** Whether a repository file is drawn as a link: everything outside the modules and the ADR record log (ADR-0048). */
export function drawn(file, moduleDirs) {
  if (moduleDirs.some((dir) => file === dir || file.startsWith(`${dir}/`))) return false;
  if (GENERATED.has(file)) return false;
  return ADR_SEEDS.has(file) || !ADR_RECORD.test(file);
}

// The model describes the repository, not a working tree: gitignored artifacts (scripts/safety-report.json
// is one) are not drawn. Outside a git work tree — a freshly generated project before its first commit —
// fall back to what is on disk, skipping output directories and dot-directories other than the ones that
// are repository content (.github, .claude, .devcontainer).
function tracked(dir) {
  const git = spawnSync("git", ["ls-files", "--", dir], { cwd: ROOT, encoding: "utf8" });
  return git.status === 0 ? git.stdout.split("\n").filter(Boolean) : null;
}

const WALK_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  ".tools",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".vite",
  "graphify-out",
  "bin",
  "png",
]);
const WALK_KEEP_DOTS = new Set([".github", ".claude", ".devcontainer"]);
const WALK_SKIP_SUFFIXES = /\.(?:tsbuildinfo|local|py[co]|swp)$/;
const WALK_SKIP_FILES = new Set(["Thumbs.db", ".DS_Store", "scripts/safety-report.json"]);

/** Every file under a repository directory, as repository-relative posix paths, sorted. */
function tree(dir) {
  const files = tracked(dir);
  if (files) return files.sort();
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && !WALK_KEEP_DOTS.has(entry.name))) return [];
        return walk(join(d, entry.name));
      }
      const path = join(d, entry.name);
      const rel = relative(ROOT, path).split(sep).join("/");
      return WALK_SKIP_FILES.has(rel) || WALK_SKIP_SUFFIXES.test(entry.name) ? [] : [rel];
    });
  return walk(join(ROOT, dir)).sort();
}

/** Every file of this checkout the model draws as a link, sorted (ADR-0046–ADR-0048). */
export function drawnFiles(moduleDirs) {
  return tree(".").filter((file) => drawn(file, moduleDirs));
}

/** Every way the model and the repository's files disagree, both directions, or an empty list (ADR-0046–ADR-0048). */
export function checkDrawn(files, links, all) {
  const problems = [];
  const targets = new Set(links.map((link) => link.target));
  for (const file of files) {
    if (!targets.has(file)) {
      problems.push(`${file} is here, but no element of the model links to it. Draw it in the same change as the file (ADR-0048).`);
    }
  }
  const here = new Set(all);
  for (const link of links) {
    if (!here.has(link.target)) {
      problems.push(
        `${link.file}:${link.line} links to ${link.target}, which is not a file here. Remove the link, or wrap it in the feature marker of the feature that owns the file.`,
      );
    }
  }
  return problems;
}

function modelFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return modelFiles(path);
    return entry.name.endsWith(".c4") ? [{ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }] : [];
  });
}

function main([modelArg]) {
  const modelDir = resolve(modelArg ?? "");
  if (!modelArg || !existsSync(modelDir)) {
    console.error(`check-architecture: name the directory that holds the model, such as \`model\`; ${modelArg ?? "none"} was given.`);
    return 2;
  }
  const files = modelFiles(modelDir);
  if (files.length === 0) {
    console.error(`check-architecture: ${modelArg} holds no .c4 file, so there is no model to check.`);
    return 2;
  }
  const links = modelLinks(files);
  const modules = presentModules();
  const all = tree(".");
  const problems = [
    ...checkModel(modules, links, relative(ROOT, modelDir).split(sep).join("/")),
    ...checkDrawn(drawnFiles(modules.map((module) => module.dir)), links, all),
  ];
  if (problems.length > 0) {
    console.error(`check-architecture: the model and the repository disagree\n\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(
    `check-architecture: every module here has one element in the model linking its README, and every tracked file outside the modules and the ADR records is drawn as a link (every link names a file that is here).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
