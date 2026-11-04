/** Shared source verification and generation protocol; no project files are changed here. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROVENANCE_FILE = ".template-provenance.json";
export const RELEASE = /^v\d+\.\d+\.\d+$/;
export const COMMIT = /^[0-9a-f]{40}$/;
export class SourceError extends Error {}
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function validateProvenance(record) {
  const { source, inputs } = record ?? {};
  const identity = inputs?.identity;
  const schema = record?.schemaVersion;
  if ((schema !== 1 && schema !== 2) || [source?.url, source?.commit, identity?.name, identity?.owner, identity?.repo].some((value) => typeof value !== "string") ||
      !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(source?.url ?? "") ||
      !COMMIT.test(source?.commit ?? "") ||
      (schema === 1 && (!RELEASE.test(source?.version ?? "") || (source.tag !== null && source.tag !== source.version))) ||
      (schema === 2 && (source.version !== undefined || source.tag !== undefined)) ||
      !/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(identity?.name ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(identity?.owner ?? "") ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(identity?.repo ?? "") ||
      !Array.isArray(inputs?.features) || inputs.features.some((id) => typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) ||
      new Set(inputs.features).size !== inputs.features.length ||
      !Number.isInteger(inputs?.year) || inputs.year < 1 || inputs.year > 9999 ||
      typeof inputs?.description?.generated !== "boolean" || typeof inputs.description.sentence !== "string" ||
      !inputs.description.sentence.trim() || inputs.description.sentence.length > 300 || /[\r\n]/.test(inputs.description.sentence) ||
      inputs.description.sentence.includes("<!--") || inputs.description.sentence.includes("-->") || inputs.description.sentence.includes("--!>")) {
    throw new SourceError(`${PROVENANCE_FILE} is malformed or has an unsupported schema. Restore the committed record; do not guess a baseline from the project's HEAD.`);
  }
  return record;
}

export function readProvenance(project) {
  const path = join(project, PROVENANCE_FILE);
  if (!existsSync(path)) return null;
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new SourceError(`${PROVENANCE_FILE} is not valid JSON. Restore the committed record.`); }
  return validateProvenance(record);
}

export function writeProvenance(project, record) {
  writeFileSync(join(project, PROVENANCE_FILE), `${JSON.stringify(validateProvenance(record), null, 2)}\n`);
}

export function defaultDescription(manifest, features) {
  const parts = features.map((id) => manifest.features[id]?.describes).filter(Boolean);
  if (!parts.length) return "No application code yet: the checks, CI and agent instructions are in place for the first module.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Starts as ${list}.`;
}

export function cloneSource(source, into) {
  try { git(undefined, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", source, into]); }
  catch (err) { throw new SourceError(`cannot fetch the template from ${source}: ${String(err.stderr || err.message).trim().split("\n")[0]}`); }
  git(into, ["config", "core.autocrlf", "false"]);
  // No checkout hook from a user's global configuration may run while verifying a source.
  git(into, ["config", "core.hooksPath", join(into, ".git", "disabled-hooks")]);
}

/** Resolve and inspect objects before checkout, and before executing either initializer. */
export function resolveSource(clone, { commit }) {
  if (!COMMIT.test(commit ?? "")) {
    throw new SourceError("The source commit must be a full lowercase 40-character SHA.");
  }
  const resolve = (ref) => {
    try { return git(clone, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim(); }
    catch { throw new SourceError(`There is no source commit ${commit} in the template source. No initializer ran.`); }
  };
  const sha = resolve(commit);
  let manifest;
  try { manifest = JSON.parse(git(clone, ["show", `${sha}:template/features.json`])); }
  catch { throw new SourceError(`Source commit ${sha} has no valid template manifest. No initializer ran.`); }
  if (manifest.provenanceSchema !== 1 && manifest.provenanceSchema !== 2) throw new SourceError("The source has an unsupported generation protocol. No initializer ran.");
  const url = `https://github.com/${manifest.identity?.owner}/${manifest.identity?.repo}`;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(url)) throw new SourceError("The source manifest has no valid upstream GitHub identity.");
  return { manifest, source: { url, commit: sha } };
}

export function checkoutSource(clone, snapshot) {
  // Reject symlinks and submodules before checkout: generation must read committed regular files.
  const entries = git(clone, ["ls-tree", "-rz", snapshot.source.commit]).split("\0").filter(Boolean);
  if (entries.some((entry) => !/^100(?:644|755) blob /.test(entry))) throw new SourceError("The template snapshot contains a symlink or submodule; it cannot be verified as regular source files.");
  git(clone, ["checkout", "--quiet", "--detach", snapshot.source.commit]);
  git(clone, ["diff", "--exit-code", "HEAD"]);
}

/** The verified snapshot's own renderer reproduces original identity, description and copyright year. */
export function generateSource(root, snapshot, inputs, out) {
  if (git(root, ["rev-parse", "HEAD"]).trim() !== snapshot.source.commit || git(root, ["status", "--porcelain"]).trim()) {
    throw new SourceError("The renderer checkout differs from its verified source commit. No initializer ran.");
  }
  const args = ["--name", inputs.identity.name, "--owner", inputs.identity.owner, "--repo", inputs.identity.repo,
    "--features", inputs.features.join(","), "--out", out];
  if (!inputs.description.generated) args.push("--description", inputs.description.sentence);
  const worker = `import { pathToFileURL } from "node:url";
const [root, args, inputs] = process.argv.slice(1);
const renderer = await import(pathToFileURL(root + "/template/init.mjs"));
await renderer.renderMain(JSON.parse(args), root, JSON.parse(inputs));`;
  const result = snapshot.manifest.provenanceSchema === 1
    ? spawnSync(process.execPath, ["--input-type=module", "-e", worker, root, JSON.stringify(args), JSON.stringify(inputs)], { cwd: root, encoding: "utf8" })
    // The worker renders the verified checkout in place; the env flag keeps main() from re-verifying a source.
    : spawnSync(process.execPath, ["template/init.mjs", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, TEMPLATE_RENDER_WORKER: "1", TEMPLATE_RENDER_INPUTS: JSON.stringify(inputs) } });
  if (result.status !== 0) throw new SourceError(`Initializer at ${snapshot.source.commit} failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1)}`);
}

export function sourceLine(source) {
  return `- Template source: [${source.commit}](${source.url}/tree/${source.commit}).`;
}
