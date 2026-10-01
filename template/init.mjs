#!/usr/bin/env node
/**
 * Resolve a published upstream snapshot independently of a GitHub template copy's new history.
 * Render that source, then record its commit and original generation inputs for exact updates.
 * Explicit local mirrors and source commits provide offline and unpublished candidate paths.
 * renderMain is the committed-source worker; it is called only after source verification.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { checkoutSource, cloneSource, defaultDescription, generateSource, resolveSource, sourceLine, writeProvenance, SourceError } from "../scripts/template-source.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reserved marker id: its blocks are deleted on every init, like the `templateOnly` paths. */
export const TEMPLATE_ONLY_ID = "template";

/**
 * A marker is one directive on its own line; the comment syntax around it belongs to the file type.
 * Its id is one feature, several joined by `|` for a block that belongs to any of them, or several
 * joined by `&` for a block that needs all of them, such as a relation between two modules.
 */
export const MARKER_RE = /ultra:(begin|end)\s+([a-z0-9-]+(?:[|&][a-z0-9-]+)*)/;

const NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class InitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function loadManifest(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "template", "features.json"), "utf8"));
}

/** Every inconsistency in the manifest, as messages. Empty means usable. */
export function validateManifest(manifest, exists) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" is not MAJOR.MINOR.PATCH.`);
  for (const [id, feature] of Object.entries(manifest.features)) {
    if (id === TEMPLATE_ONLY_ID || !/^[a-z0-9-]+$/.test(id)) problems.push(`"${id}" is not a usable feature id.`);
    for (const path of feature.paths) {
      if (!exists(path)) problems.push(`feature "${id}" owns "${path}", which does not exist.`);
    }
  }
  for (const path of manifest.templateOnly) {
    if (!exists(path)) problems.push(`template-only path "${path}" does not exist.`);
  }
  // Several features may own the same path, which is then kept when any of them is selected. A path
  // INSIDE another feature's path cannot be allowed: the two disagree about a file, and it would be kept
  // or deleted by whichever path is processed last rather than by the selection.
  const owned = Object.entries(manifest.features).flatMap(([id, feature]) => feature.paths.map((path) => [id, path]));
  for (const [id, path] of owned) {
    for (const [other, outer] of owned) {
      if (other === id || path === outer) continue;
      if (isUnder(path, outer)) problems.push(`"${path}" is inside "${outer}", which "${other}" owns.`);
    }
    if (manifest.templateOnly.some((only) => isUnder(path, only))) problems.push(`"${path}" is owned by "${id}" and is template-only.`);
  }
  for (const [preset, ids] of Object.entries(manifest.presets)) {
    for (const id of ids) {
      if (!Object.hasOwn(manifest.features, id)) problems.push(`preset "${preset}" names unknown feature "${id}".`);
    }
  }
  return problems;
}

export function resolveSelection(manifest, { preset, features }) {
  if ((preset === undefined) === (features === undefined)) {
    throw new InitError("Pass exactly one of --preset or --features (use --preset minimal for no features).");
  }
  let ids;
  if (preset !== undefined) {
    if (!Object.hasOwn(manifest.presets, preset)) {
      throw new InitError(`Unknown preset "${preset}". Known: ${Object.keys(manifest.presets).join(", ")}.`);
    }
    ids = manifest.presets[preset];
  } else {
    ids = features.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const unknown = ids.filter((id) => !Object.hasOwn(manifest.features, id));
  if (unknown.length > 0) {
    throw new InitError(`Unknown feature(s): ${unknown.join(", ")}. Known: ${Object.keys(manifest.features).join(", ")}.`);
  }
  return new Set(ids);
}

/**
 * `nameFrom` is the repository name `name` was derived from, when no --name was given: a name that does
 * not fit is then the repository's, and the message says so rather than blaming a flag nobody passed.
 */
export function validateIdentity({ name, owner, repo }, { nameFrom } = {}) {
  const problems = [];
  const rule = "2-64 characters of lowercase letters, digits and hyphens, starting with a letter";
  if (name === undefined || !NAME_RE.test(name)) {
    problems.push(
      nameFrom === undefined
        ? `--name must be ${rule}.`
        : `The project name ${JSON.stringify(name)}, made from the repository name ${JSON.stringify(nameFrom)}, must be ${rule}; pass --name to name the project yourself.`,
    );
  }
  if (owner === undefined || !OWNER_RE.test(owner)) {
    problems.push("--owner must be a GitHub user or organization name.");
  }
  if (repo !== undefined && !REPO_RE.test(repo)) {
    problems.push("--repo may contain only letters, digits, '.', '_' and '-'.");
  }
  if (problems.length > 0) throw new InitError(problems.join("\n"));
  return { name, owner, repo: repo ?? name };
}

/**
 * Deleted for this selection: each unselected feature's paths, plus everything template-only. A path
 * several features own belongs to any of them, so it goes only when none of its owners is selected.
 */
export function removedPaths(manifest, selected) {
  const kept = new Set(Object.entries(manifest.features).filter(([id]) => selected.has(id)).flatMap(([, feature]) => feature.paths));
  const unselected = Object.entries(manifest.features).filter(([id]) => !selected.has(id));
  return [...new Set([...manifest.templateOnly, ...unselected.flatMap(([, feature]) => feature.paths).filter((path) => !kept.has(path))])];
}

export const isUnder = (file, path) => file === path || file.startsWith(`${path}/`);

/**
 * Keeps the blocks of selected features and deletes the rest, marker lines included. A block whose id
 * joins several features with `|` is kept when any one of them is selected, and one joined with `&` only
 * when all of them are; its end must name the same ids in the same order. Throws on an unknown id, an id
 * that mixes `|` and `&`, a nested begin, an end without its begin, or a block never closed — a malformed
 * marker would otherwise delete the rest of the file silently.
 */
export function applyMarkers(text, selected, known, file = "<text>") {
  const lines = text.split("\n");
  const out = [];
  let open = null;
  // A removed block usually sits between blank lines; dropping the second keeps the gap single.
  let justRemoved = false;
  for (let i = 0; i < lines.length; i++) {
    const match = MARKER_RE.exec(lines[i]);
    if (!match) {
      if (open !== null && !open.keep) continue;
      const doubledBlank = justRemoved && lines[i].trim() === "" && (out.length === 0 || out.at(-1).trim() === "");
      justRemoved = false;
      if (!doubledBlank) out.push(lines[i]);
      continue;
    }
    const [, kind, id] = match;
    const where = `${file}:${i + 1}`;
    const all = id.includes("&");
    if (all && id.includes("|")) {
      throw new InitError(`${where}: "${id}" mixes | and &; a block needs any of its features or all of them, so write two blocks.`);
    }
    const ids = id.split(/[|&]/);
    for (const one of ids) {
      if (one !== TEMPLATE_ONLY_ID && !known.has(one)) throw new InitError(`${where}: marker names unknown feature "${one}".`);
    }
    // Joining the reserved id to a feature reads as "kept when that feature is selected" and would
    // quietly mean the opposite, since a template block always goes.
    if (ids.length > 1 && ids.includes(TEMPLATE_ONLY_ID)) {
      throw new InitError(`${where}: the reserved id "${TEMPLATE_ONLY_ID}" cannot be joined to a feature.`);
    }
    if (kind === "begin") {
      if (open !== null) {
        throw new InitError(`${where}: "${id}" block opens inside the "${open.id}" block from line ${open.line}; blocks do not nest.`);
      }
      const chosen = (one) => selected.has(one);
      open = { id, line: i + 1, keep: !ids.includes(TEMPLATE_ONLY_ID) && (all ? ids.every(chosen) : ids.some(chosen)) };
    } else {
      if (open === null || open.id !== id) {
        throw new InitError(`${where}: end of "${id}" block that was never opened.`);
      }
      justRemoved = !open.keep;
      open = null;
    }
  }
  if (open !== null) throw new InitError(`${file}:${open.line}: "${open.id}" block is never closed.`);
  return out.join("\n");
}

/**
 * Two passes through placeholders, so no replacement can rewrite the output of another — a project
 * named after the template's owner would otherwise be renamed a second time. The owner/repo pair
 * goes first, so a URL keeps the owner and repository it names even when the two are equal.
 * Registry namespaces come before it and are lowercased, while GitHub names keep the owner's case.
 */
export function replaceIdentity(text, from, to) {
  const pairs = [
    [`@${from.owner.toLowerCase()}/${from.name}`, `@${to.owner.toLowerCase()}/${to.name}`],
    [`@${from.owner}/${from.name}`, `@${to.owner.toLowerCase()}/${to.name}`],
    [`ghcr.io/${from.owner.toLowerCase()}/`, `ghcr.io/${to.owner.toLowerCase()}/`],
    [`io.github.${from.owner.toLowerCase()}/`, `io.github.${to.owner.toLowerCase()}/`],
    [`${from.owner}/${from.repo}`, `${to.owner}/${to.repo}`],
    [from.repo, to.repo],
    [from.name, to.name],
    [from.owner, to.owner],
  ];
  let result = text;
  pairs.forEach(([before], i) => {
    result = result.split(before).join(`\u0000${i}\u0000`);
  });
  pairs.forEach(([, after], i) => {
    result = result.split(`\u0000${i}\u0000`).join(after);
  });
  return result;
}

/**
 * Records which template release, and which features, a project started from. A repository created from
 * a template has none of its history or tags, so without this line nobody can tell later which template
 * changes a project already has. Added after identity replacement, so the link keeps naming the template.
 */
export function recordOrigin(changelog, manifest, selected, file = "CHANGELOG.md") {
  const heading = "## [Unreleased]";
  if (!changelog.includes(heading)) throw new InitError(`${file} has no "${heading}" heading to record the template version under.`);
  const { owner, repo } = manifest.identity;
  const tag = `v${manifest.version}`;
  const features = [...selected].join(", ") || "no features";
  return changelog.replace(heading, `${heading}\n\n- Initialized from [${repo} ${tag}](https://github.com/${owner}/${repo}/releases/tag/${tag}) with ${features}.`);
}

/** The README line init replaces with a sentence on what the project is. Invisible where Markdown renders. */
export const DESCRIPTION_ANCHOR = "<!-- project description -->";
const WRITTEN_BY_INIT = "<!-- Written by init from the selected features: replace it with what this project is for. -->";

/**
 * A sentence on what a new project is, from the features that are part of the product. It is true the day
 * init runs; the owner replaces it once the project is more than its starting point.
 */
export function describeProject(manifest, selected) {
  return defaultDescription(manifest, [...selected]);
}

/** --description is one line of prose; a newline or a comment marker would break the README around it. */
export function validateDescription(text) {
  const sentence = text.trim();
  if (sentence === "" || sentence.length > 300 || /[\r\n]/.test(sentence) || sentence.includes("<!--") || sentence.includes("-->") || sentence.includes("--!>")) {
    throw new InitError("--description must be one line of 1-300 characters, with no HTML comment.");
  }
  return sentence;
}

/** Writes the description at the anchor. A generated one carries a note saying so; the owner's own does not. */
export function recordDescription(readme, sentence, generated, file = "README.md") {
  const lines = readme.split("\n");
  const at = lines.findIndex((line) => line.trim() === DESCRIPTION_ANCHOR);
  if (at === -1) throw new InitError(`${file} has no "${DESCRIPTION_ANCHOR}" line to write the project description at.`);
  lines.splice(at, 1, ...(generated ? [WRITTEN_BY_INIT, sentence] : [sentence]));
  return lines.join("\n");
}

function gitTracked(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\0")
      .filter(Boolean);
  } catch {
    throw new InitError("This is not a git checkout. Clone the repository created from the template and run init there.", 2);
  }
}

function assertClean(root) {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.trim() !== "") {
    throw new InitError("The working tree has uncommitted changes. Commit or stash them first, so the result of init is one reviewable diff.", 2);
  }
}

/** Builds the complete result in memory. Nothing is written until every file has been processed. */
export function plan(root, manifest, selected, identity, description = { sentence: describeProject(manifest, selected), generated: true }, year = new Date().getUTCFullYear()) {
  const removed = removedPaths(manifest, selected);
  const known = new Set(Object.keys(manifest.features));
  const result = { deleted: [], files: [] };
  for (const file of gitTracked(root)) {
    if (removed.some((path) => isUnder(file, path))) {
      result.deleted.push(file);
      continue;
    }
    if (!existsSync(join(root, file))) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.includes(0)) {
      result.files.push({ file, data: bytes, changed: false });
      continue;
    }
    const text = bytes.toString("utf8");
    let next = replaceIdentity(applyMarkers(text, selected, known, file), manifest.identity, identity);
    if (file === "CHANGELOG.md") next = recordOrigin(next, manifest, selected, file);
    if (file === "README.md") next = recordDescription(next, description.sentence, description.generated, file);
    // The MIT notice must retain the upstream attribution; add the adopter's notice without rewriting it.
    if (file === "LICENSE") next = text.replace(/^(Copyright \(c\) \d{4} .+)$/m, `Copyright (c) ${year} ${identity.owner}\n$1`);
    result.files.push({ file, data: next, changed: next !== text });
  }
  return result;
}

function pruneEmptyParents(root, file) {
  for (let dir = dirname(join(root, file)); dir !== root && dir.startsWith(root); dir = dirname(dir)) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) return;
    rmdirSync(dir);
  }
}

/** owner and repository from a GitHub remote URL (https or ssh), or null for anything else. */
export function originIdentity(url) {
  const match = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * The origin identity to default from, or null. The template's own remote names the template, not the
 * project being created, so it is ignored: a clone of ULTRA-TEMPLATE itself (template-test.yml runs init in
 * one) would otherwise hand the template's repository name and links to the generated project.
 */
export function originDefaults(manifest, url) {
  const origin = originIdentity(url);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (origin === null || (same(origin.owner, manifest.identity.owner) && same(origin.repo, manifest.identity.repo))) return null;
  return origin;
}

/** A repository name as a project name: lowercase, with every other run of characters as one hyphen. */
export const toProjectName = (repo) => repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function readOrigin(root) {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Asks for what the command line left out. Only in a terminal: a script or CI that forgets an argument
 * gets the same error as before rather than a prompt it cannot answer.
 */
async function ask(manifest, values) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = async (question, fallback) => (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback;
  try {
    values.owner = await prompt("GitHub owner", values.owner);
    values.name = await prompt("Project name", values.name);
    if (values.preset === undefined && values.features === undefined) {
      const ids = Object.keys(manifest.features);
      console.log("\nFeatures:");
      ids.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}. ${id.padEnd(14)} ${manifest.features[id].summary}`));
      console.log(`\nPresets: ${Object.keys(manifest.presets).join(", ")}`);
      const answer = (await rl.question("Preset name, or feature numbers such as 1,3 (empty for none): ")).trim();
      if (Object.hasOwn(manifest.presets, answer)) values.preset = answer;
      else values.features = answer.split(",").map((part) => ids[Number(part.trim()) - 1] ?? part.trim()).join(",");
    }
    if (values.description === undefined) {
      const answer = (await rl.question("One sentence on what this project does (empty for one built from the features): ")).trim();
      if (answer !== "") values.description = answer;
    }
  } catch (err) {
    rl.close();
    throw err;
  }
  // The last question comes after the plan is built, so the interface stays open until it is asked.
  return async (summary) => {
    try {
      return /^y(es)?$/i.test((await rl.question(`\n${summary}\nApply? [y/N]: `)).trim());
    } finally {
      rl.close();
    }
  };
}

const USAGE = `Usage:
  node template/init.mjs                     in a terminal: asks for everything the arguments leave out
  node template/init.mjs --list
  node template/init.mjs [--name <project>] [--owner <github-owner>] (--preset <preset> | --features <a,b>)
                         [--repo <repository>] [--description <sentence>] [--out <directory>] [--dry-run]
  --owner and --repo default to the origin remote, and --name to the repository name.
  --owner/--repo are the GitHub repository: every link, every badge, and the README title.
  --name is the project: package names, with the npm scope from --owner, lowercased.
  --description is written under the README's title; without it, a sentence is built from the features.`;

export async function renderMain(argv = process.argv.slice(2), root = ROOT, inputs) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      name: { type: "string" },
      owner: { type: "string" },
      repo: { type: "string" },
      description: { type: "string" },
      preset: { type: "string" },
      features: { type: "string" },
      out: { type: "string" },
      list: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const manifest = loadManifest(root);
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    console.log("Features:");
    for (const [id, feature] of Object.entries(manifest.features)) console.log(`  ${id.padEnd(14)} ${feature.summary}`);
    console.log("\nPresets:");
    for (const [id, ids] of Object.entries(manifest.presets)) console.log(`  ${id.padEnd(14)} ${ids.join(", ") || "(chassis only)"}`);
    return 0;
  }

  const problems = validateManifest(manifest, (path) => existsSync(join(root, path)));
  if (problems.length > 0) throw new InitError(`The template is inconsistent:\n  ${problems.join("\n  ")}`);

  // A repository created from the template already names its owner and repository in origin.
  const origin = originDefaults(manifest, readOrigin(root));
  values.owner ??= origin?.owner;
  values.repo ??= origin?.repo;
  const nameFrom = values.name === undefined ? values.repo : undefined;
  values.name ??= values.repo === undefined ? undefined : toProjectName(values.repo);

  const interactive = process.stdin.isTTY && process.stdout.isTTY &&
    (values.preset === undefined && values.features === undefined);
  const confirm = interactive ? await ask(manifest, values) : null;

  const selected = resolveSelection(manifest, values);
  const identity = validateIdentity(values, { nameFrom });
  const description = inputs?.description ?? (values.description === undefined
    ? { sentence: describeProject(manifest, selected), generated: true }
    : { sentence: validateDescription(values.description), generated: false });

  const out = values.out === undefined ? null : resolve(values.out);
  if (out === null) assertClean(root);
  else if (existsSync(out) && readdirSync(out).length > 0) throw new InitError(`--out ${out} exists and is not empty.`, 2);

  const result = plan(root, manifest, selected, identity, description, inputs?.year);
  const rewritten = result.files.filter((f) => f.changed).length;
  const summary = `${identity.name} (${identity.owner}/${identity.repo}) with ${[...selected].join(", ") || "no features"}: ` +
    `${result.deleted.length} file(s) deleted, ${rewritten} rewritten.`;

  if (values["dry-run"]) {
    console.log(`Dry run — nothing written.\n${summary}\nDeleted:\n  ${result.deleted.join("\n  ")}`);
    return 0;
  }
  if (confirm !== null && !(await confirm(summary))) {
    console.log("Nothing written.");
    return 0;
  }
  if (out !== null) {
    for (const { file, data } of result.files) {
      mkdirSync(dirname(join(out, file)), { recursive: true });
      writeFileSync(join(out, file), data);
    }
  } else {
    // Whole paths, not only their tracked files: an ignored node_modules or dist left behind (the Dev
    // Container runs setup before anyone runs init) would keep a removed module's directory — and so
    // the module, as far as setup and verify can tell — alive.
    for (const path of removedPaths(manifest, selected)) {
      rmSync(join(root, path), { recursive: true, force: true });
      pruneEmptyParents(root, path);
    }
    for (const { file, data, changed } of result.files) if (changed) writeFileSync(join(root, file), data);
  }

  console.log(`Initialized ${summary}${out === null ? "" : `\nWritten to ${out}`}

Next:
  ${out === null ? "git status                      # review the result" : `cd ${out} && git init -b main && git add -A    # hygiene checks tracked files`}
  node scripts/setup.mjs && node scripts/verify.mjs
  git add -A && git commit -m "chore: initialize project"
  git push && node scripts/configure-github.mjs   # squash-only merges, required verify check, security settings`);
  return 0;
}

/** A GitHub template copy has new history; always resolve the upstream snapshot independently. */
export async function main(argv = process.argv.slice(2), root = ROOT) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    name: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, description: { type: "string" },
    preset: { type: "string" }, features: { type: "string" }, out: { type: "string" },
    source: { type: "string" }, "source-commit": { type: "string" },
    list: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.list || values.help) {
    const code = await renderMain([values.help ? "--help" : "--list"], root);
    if (values.help) console.log("\nSources: default = published upstream release. --source <mirror> uses its verified tag;\n  --source <local-git-path> --source-commit <40-character-sha> is explicit offline/unreleased generation.");
    return code;
  }
  if (values["source-commit"] && !values.source) throw new InitError("--source-commit requires an explicit --source local Git checkout.");
  if (values["source-commit"] && !existsSync(resolve(values.source))) throw new InitError("--source-commit requires a local Git checkout, not a network URL.");
  const bootstrap = loadManifest(root);
  const origin = originDefaults(bootstrap, readOrigin(root));
  values.owner ??= origin?.owner;
  values.repo ??= origin?.repo;
  values.name ??= values.repo === undefined ? undefined : toProjectName(values.repo);
  const confirm = process.stdin.isTTY && process.stdout.isTTY && values.preset === undefined && values.features === undefined
    ? await ask(bootstrap, values) : null;
  const identity = validateIdentity(values);
  const out = values.out === undefined ? null : resolve(values.out);
  if (out === null) assertClean(root);
  else if (existsSync(out) && readdirSync(out).length) throw new InitError(`--out ${out} exists and is not empty.`, 2);
  const version = `v${bootstrap.version}`;
  const upstream = `https://github.com/${bootstrap.identity.owner}/${bootstrap.identity.repo}`;
  if (!values.source) {
    let response;
    try { response = await fetch(`https://api.github.com/repos/${bootstrap.identity.owner}/${bootstrap.identity.repo}/releases/tags/${version}`, { signal: AbortSignal.timeout(15_000) }); }
    catch { throw new InitError(`Cannot verify publication of ${version}. Retry online, or use an explicit verified local source. Nothing was written.`, 2); }
    if (!response.ok) throw new InitError(`${version} is not a verified published release (HTTP ${response.status}). Wait for publication or use an explicit local source commit. Nothing was written.`, 2);
    const release = await response.json();
    if (release.draft || release.prerelease || release.tag_name !== version) throw new InitError(`${version} is not a stable published release. Nothing was written.`, 2);
  }
  const work = mkdtempSync(join(tmpdir(), "template-source-"));
  try {
    const clone = join(work, "source");
    cloneSource(values.source ?? `${upstream}.git`, clone);
    const snapshot = resolveSource(clone, { version, commit: values["source-commit"], tag: values["source-commit"] ? null : version });
    checkoutSource(clone, snapshot);
    const features = [...resolveSelection(snapshot.manifest, values)];
    const description = values.description === undefined
      ? { sentence: describeProject(snapshot.manifest, new Set(features)), generated: true }
      : { sentence: validateDescription(values.description), generated: false };
    const inputs = { identity, features, description, year: new Date().getUTCFullYear() };
    const generated = join(work, "generated");
    generateSource(clone, snapshot, inputs, generated);
    writeProvenance(generated, { schemaVersion: 1, source: snapshot.source, inputs });
    const changelog = join(generated, "CHANGELOG.md");
    let text = readFileSync(changelog, "utf8");
    if (snapshot.source.tag === null) {
      text = text.replace(`](${snapshot.source.url}/releases/tag/${version})`, ` source](${snapshot.source.url}/tree/${snapshot.source.commit})`);
    }
    writeFileSync(changelog, text.replace("## [Unreleased]", `## [Unreleased]\n\n${sourceLine(snapshot.source)}`));
    const summary = `${identity.name} (${identity.owner}/${identity.repo}) from ${version} at ${snapshot.source.commit}, features: ${features.join(", ") || "none"}.`;
    if (values["dry-run"]) { console.log(`Dry run — nothing written.\n${summary}`); return 0; }
    if (confirm && !(await confirm(summary))) { console.log("Nothing written."); return 0; }
    const files = [];
    const walk = (dir, prefix = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), file);
        else files.push({ file, data: readFileSync(join(dir, entry.name)) });
      }
    };
    walk(generated);
    const destination = out ?? root;
    if (out === null) {
      const kept = new Set(files.map(({ file }) => file));
      const tracked = gitTracked(root);
      for (const path of removedPaths(bootstrap, new Set(features))) rmSync(join(root, path), { recursive: true, force: true });
      for (const file of tracked.filter((file) => !kept.has(file))) {
        rmSync(join(root, file), { force: true });
        pruneEmptyParents(root, file);
      }
    }
    for (const { file, data } of files) {
      mkdirSync(dirname(join(destination, file)), { recursive: true });
      writeFileSync(join(destination, file), data);
    }
    console.log(`Initialized ${summary}\n${out === null ? "Review with git diff." : `Written to ${out}; initialize Git and add the files.`}\nNext: node scripts/setup.mjs && node scripts/verify.mjs`);
    return 0;
  } catch (err) {
    if (err instanceof SourceError) throw new InitError(err.message, 2);
    throw err;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
      process.exit();
    },
    (err) => {
      console.error(`init: ${err.message}`);
      if (!(err instanceof InitError)) console.error(USAGE);
      process.exit(err instanceof InitError ? err.code : 1);
    },
  );
}
