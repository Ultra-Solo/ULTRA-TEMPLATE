/**
 * The architecture model, held to the modules that are really here.
 *
 * AGENTS.md asks for the model to change in the same pull request as the structure it describes, and a
 * model nobody compares with the code drifts into a picture of a system that no longer exists. So each
 * module present must have exactly one element in the model that links to its README, and every README
 * link in the model must name a module that is present. The model's own module is exempt: it is the
 * picture, not something in it.
 *
 * ADR-0046 holds the same discipline over the chassis scripts: every top-level scripts/*.mjs on disk
 * must be the target of some model link, and every model link into scripts/ must name a script that is
 * here. Feature-owned scripts (scripts/check-contract.mjs, scripts/check-facts.mjs) carry their
 * feature's marker in the model, so a generated project keeps the link exactly when it keeps the file.
 *
 *   node scripts/check-architecture.mjs <model-dir>     # from the module that holds the model
 *
 * The model's `link <path>` lines are read as text, relative to the file they are in; nothing else in
 * the model is parsed. Exit 0 agrees · 1 disagrees · 2 the model cannot be read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
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

/** The top-level chassis scripts of this checkout, as repository-relative paths, sorted. */
export function chassisScripts() {
  return readdirSync(join(ROOT, SCRIPTS), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => `${SCRIPTS}/${entry.name}`)
    .sort();
}

/** Every way the model and the chassis scripts disagree, or an empty list (ADR-0046). */
export function checkScripts(scripts, links) {
  const problems = [];
  const scriptLinks = links.filter((link) => link.target.startsWith(`${SCRIPTS}/`) && link.target.endsWith(".mjs"));
  for (const script of scripts) {
    if (!scriptLinks.some((link) => link.target === script)) {
      problems.push(`${script} is here, but no element of the model links to it. Draw it in the same change as the script (ADR-0046).`);
    }
  }
  for (const link of scriptLinks) {
    if (!scripts.includes(link.target)) {
      problems.push(
        `${link.file}:${link.line} links to ${link.target}, which is not a script here. Remove the link, or wrap it in the feature marker of the feature that owns the script.`,
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
  const problems = [
    ...checkModel(presentModules(), links, relative(ROOT, modelDir).split(sep).join("/")),
    ...checkScripts(chassisScripts(), links),
  ];
  if (problems.length > 0) {
    console.error(`check-architecture: the model and the repository disagree\n\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(
    `check-architecture: every module here has one element in the model, every element's README is a module here, and every chassis script is drawn as a link.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
