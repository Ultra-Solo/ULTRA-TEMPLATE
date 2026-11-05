/**
 * The architecture model, held to the modules that are really here.
 *
 * AGENTS.md asks for the model to change in the same pull request as the structure it describes, and a
 * model nobody compares with the code drifts into a picture of a system that no longer exists. So each
 * module present must have exactly one element in the model that links to its README, and every README
 * link in the model must name a module that is present. The model's own module is exempt: it is the
 * picture, not something in it.
 *
 * ADR-0046 holds the same discipline over the chassis scripts, and ADR-0047 extends it to every file
 * under scripts/ and every workflow in .github/workflows/: each tracked file must be the target of some
 * model link, and every model link into those directories must name a file that is here. Feature-owned
 * files (scripts/contract/, scripts/rules/, scripts/check-contract.mjs, ...) carry their feature's
 * marker in the model, so a generated project keeps the link exactly when it keeps the file.
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
  for (const link of links.filter((l) => l.target.endsWith(`/${README}`))) {
    const dir = link.target.slice(0, -README.length - 1);
    if (!described.some((m) => m.dir === dir))
      problems.push(
        `${link.file}:${link.line} links to ${link.target}, which is not the README of a module here. Remove the element, or its module was renamed.`,
      );
  }
  return problems;
}

const SCRIPTS = "scripts";
const WORKFLOWS = ".github/workflows";

// The model describes the repository, not a working tree: gitignored artifacts (scripts/safety-report.json
// is one) are not drawn. Outside a git work tree — a freshly generated project before its first commit —
// fall back to what is on disk.
function tracked(dir) {
  const git = spawnSync("git", ["ls-files", "--", dir], { cwd: ROOT, encoding: "utf8" });
  return git.status === 0 ? git.stdout.split("\n").filter(Boolean) : null;
}

/** Every file under a repository directory, as repository-relative posix paths, sorted. */
function tree(dir) {
  const files = tracked(dir);
  if (files) return files;
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      const path = join(d, entry.name);
      return entry.isDirectory() ? walk(path) : [relative(ROOT, path).split(sep).join("/")];
    });
  return walk(join(ROOT, dir)).sort();
}

/** Every chassis file of this checkout — all of scripts/, at any depth — as paths, sorted (ADR-0046, ADR-0047). */
export function chassisFiles() {
  return tree(SCRIPTS);
}

/** Every CI workflow of this checkout, as repository-relative paths, sorted (ADR-0047). */
export function workflowFiles() {
  return tree(WORKFLOWS).filter((file) => file.endsWith(".yml"));
}

/** Every way the model and the files under `dir` disagree, both directions, or an empty list (ADR-0047). */
function checkTree(files, links, dir, adr) {
  const problems = [];
  const fileLinks = links.filter((link) => link.target.startsWith(`${dir}/`));
  for (const file of files) {
    if (!fileLinks.some((link) => link.target === file)) {
      problems.push(`${file} is here, but no element of the model links to it. Draw it in the same change as the file (${adr}).`);
    }
  }
  for (const link of fileLinks) {
    if (!files.includes(link.target)) {
      problems.push(
        `${link.file}:${link.line} links to ${link.target}, which is not a file here. Remove the link, or wrap it in the feature marker of the feature that owns the file.`,
      );
    }
  }
  return problems;
}

/** Every way the model and the chassis files disagree, or an empty list (ADR-0046, amended by ADR-0047). */
export function checkScripts(files, links) {
  return checkTree(files, links, SCRIPTS, "ADR-0047");
}

/** Every way the model and the CI workflows disagree, or an empty list (ADR-0047). */
export function checkWorkflows(files, links) {
  return checkTree(files, links, WORKFLOWS, "ADR-0047");
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
  const problems = [
    ...checkModel(presentModules(), links, relative(ROOT, modelDir).split(sep).join("/")),
    ...checkScripts(chassisFiles(), links),
    ...checkWorkflows(workflowFiles(), links),
  ];
  if (problems.length > 0) {
    console.error(`check-architecture: the model and the repository disagree\n\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(
    `check-architecture: every module here has one element in the model, every element's README is a module here, and every file in scripts/ and every CI workflow is drawn as a link.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
