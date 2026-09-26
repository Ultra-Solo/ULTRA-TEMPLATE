/**
 * Documentation shape: one set of instructions for agents, and a docs tree that indexes itself.
 *
 * Every assistant reads a different filename — AGENTS.md, CLAUDE.md, GEMINI.md,
 * .github/copilot-instructions.md — and the failure mode is not a missing file but four files that
 * each say something slightly different, with nothing to say which one is current. So exactly one
 * of them carries instructions and the rest point at it, which is what this checks:
 *
 *   1. AGENTS.md exists, says something, and is the only one in the tree.
 *   2. CLAUDE.md is the import line and nothing else, so it cannot drift from AGENTS.md.
 *   3. Every other vendor file names AGENTS.md and stays short: a pointer, never a second copy.
 *   4. Every skill under .claude/skills/<name>/SKILL.md has frontmatter an agent can select on —
 *      a name matching its directory, and a description within the length the loader accepts.
 *   5. Every directory under docs/ has a README.md linking the documents beside it, and
 *      docs/README.md links each of those indexes. A document nothing links to is a document
 *      nobody revises: it is how a docs tree becomes a pile of stale forks of the same page.
 *   6. Every relative Markdown link resolves, inside the repository. Code spans and fenced blocks are
 *      not links.
 *   7. Nothing is tracked under a name no tool reads: the singular AGENT.md, or a spelling that
 *      differs from AGENTS.md only in case, which a case-insensitive filesystem will hide.
 *   8. Copilot's .github/agents and .github/prompts files carry the frontmatter they are selected
 *      on and defer to AGENTS.md, so the vendor surface never becomes a second rulebook.
 *   9. .claude/settings.json, when tracked, parses, and every hook in it is a command whose files in
 *      the repository ($CLAUDE_PROJECT_DIR/…) are tracked. A hook that names a missing script fails in
 *      every session that starts, far from the change that broke it.
 *  10. Every generated block in a Markdown file (scripts/generate-docs.mjs) says what its source says
 *      now, and names a source that is here. A value restated by hand is how a README goes stale.
 *  11. The ADR index's status column says what each record's own status line says, written short —
 *      "Accepted · Amends [ADR-0006](…)" is "Accepted, amends 0006" — and each number it shows, in a
 *      row or a status, is the number of the record it links. The record states its status; the
 *      index's copy goes stale the day a record is amended or superseded, unless it is compared.
 *  12. A record that a later one amends or supersedes says so on its own status line ("Amended by",
 *      "Superseded by"), and every such pointer is answered by the later record. Records are amended,
 *      not rewritten: without the pointer, the old record reads as current to anyone who opens it.
 *
 *   node scripts/check-docs.mjs
 *
 * Exit 0 clean · 1 a rule is broken · 2 the repository cannot be inspected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DocsError, regenerate } from "./generate-docs.mjs";

export const CANONICAL = "AGENTS.md";
export const IMPORT_FILE = "CLAUDE.md";
/** Claude Code reads `@file` as an import, so this one line is the whole file. */
export const IMPORT_TEXT = "@AGENTS.md\n";
export const POINTERS = ["GEMINI.md", ".github/copilot-instructions.md"];
/** Long enough for a sentence and a link, short enough that instructions cannot hide here. */
export const MAX_POINTER_LINES = 20;
/** The singular name some tools once looked for: a file nothing reads today. */
export const WRONG_NAME = "AGENT.MD";
/** Copilot's own customization surface: task-shaped wrappers, never a second set of rules. */
export const CLAUDE_SETTINGS = ".claude/settings.json";

/** A record's status: what its `**Status:**` line says before the date, or null when it has none. */
export function recordStatus(text) {
  const line = normalize(text)
    .split("\n")
    .find((l) => l.startsWith("**Status:**"));
  return line === undefined ? null : line.slice("**Status:**".length).split(/\s*·\s*\*\*Date:\*\*/)[0].trim();
}

/**
 * A record's status as the index writes it: each link to a record as its number, numbers and clauses
 * separated by commas, and each clause after the first in lower case. "Accepted · Amends [ADR-0005](…)
 * and [ADR-0008](…)" is "Accepted, amends 0005, 0008".
 */
export function indexStatus(status) {
  return status
    .replace(/\[ADR-(\d{4})\]\([^)]*\)/g, "$1")
    .replace(/(\d{4}) and (?=\d{4})/g, "$1, ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/, ([A-Z])/g, (_, letter) => `, ${letter.toLowerCase()}`)
    .trim();
}

const RELATIONS = ["amends", "supersedes", "amended by", "superseded by"];
const INVERSE = { amends: "amended by", supersedes: "superseded by", "amended by": "amends", "superseded by": "supersedes" };

/** The records a status names under each relation, as their numbers: "Amends [ADR-0006](…)" gives amends ["0006"]. */
export function statusRelations(status) {
  const relations = Object.fromEntries(RELATIONS.map((word) => [word, []]));
  const clause = /\b(amends|supersedes|amended by|superseded by)\s+((?:\[ADR-\d{4}\]\([^)]*\)(?:\s*,\s*|\s+and\s+)?)+)/gi;
  for (const [, word, list] of status.matchAll(clause)) {
    relations[word.toLowerCase()].push(...[...list.matchAll(/\[ADR-(\d{4})\]/g)].map((match) => match[1]));
  }
  return relations;
}

/** Rule 12: amendments and supersessions are stated at both ends, and only a later record makes one. */
function checkAdrRelations(root, tracked, failures) {
  const records = new Map();
  for (const path of tracked.filter((p) => p.startsWith(`${ADR_DIR}/`) && /^\d{4}-[^/]+\.md$/.test(p.slice(ADR_DIR.length + 1)))) {
    const file = basename(path);
    const status = recordStatus(readFileSync(join(root, path), "utf8"));
    if (status !== null) records.set(file.slice(0, 4), { file, relations: statusRelations(status) });
  }
  const says = (word, number) => `says it ${word.endsWith(" by") ? "is " : ""}${word} ADR-${number}`;
  for (const [number, { file, relations }] of records) {
    for (const word of RELATIONS) {
      for (const other of relations[word]) {
        const target = records.get(other);
        if (target === undefined) {
          failures.push(`\`${ADR_DIR}/${file}\` ${says(word, other)}, which is not a record here.`);
        } else if (word.endsWith(" by") ? other <= number : other >= number) {
          failures.push(
            `\`${ADR_DIR}/${file}\` ${says(word, other)}, ${word.endsWith(" by") ? "an earlier" : "a later"} record: a record amends or supersedes only the records before it.`,
          );
        } else if (!target.relations[INVERSE[word]].includes(number)) {
          const answer = INVERSE[word][0].toUpperCase() + INVERSE[word].slice(1);
          failures.push(`\`${ADR_DIR}/${target.file}\` must say "${answer} [ADR-${number}](${file})" on its status line: ADR-${number} ${says(word, other)}.`);
        }
      }
    }
  }
}

/** Rule 11: every row of the ADR index shows its record's number and the status its record states. */
function checkAdrIndex(root, tracked, failures) {
  const indexPath = `${ADR_DIR}/${INDEX}`;
  if (!tracked.includes(indexPath)) return;
  const read = (file) => readFileSync(join(root, ADR_DIR, file), "utf8");
  const number = (file) => /^(\d{4})-/.exec(basename(file))?.[1];
  for (const line of normalize(read(INDEX)).split("\n")) {
    const cells = line.trim().startsWith("|") ? line.trim().split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()) : [];
    const link = /^\[([^\]]+)\]\(\.?\/?([^)/\s]+\.md)\)$/.exec(cells[0] ?? "");
    // A row that links nothing beside the index is not a record's; rule 6 names a link that goes nowhere.
    if (!link || cells.length < 2 || !tracked.includes(`${ADR_DIR}/${link[2]}`)) continue;
    const [, shown, file] = link;
    if (shown !== number(file)) {
      failures.push(`\`${indexPath}\` links \`${file}\` as ${shown}. A record's number is the one its file name starts with.`);
      continue;
    }
    const status = recordStatus(read(file));
    if (status === null) {
      failures.push(`\`${ADR_DIR}/${file}\` has no \`**Status:**\` line, so its row in the index states a status nothing records. Copy the line from 0000-template.md.`);
      continue;
    }
    for (const [, cited, target] of status.matchAll(/\[ADR-(\d{4})\]\(([^)]*)\)/g)) {
      if (number(target) !== cited) failures.push(`\`${ADR_DIR}/${file}\`'s status names ADR-${cited} but links \`${target}\`.`);
    }
    const expected = indexStatus(status);
    if (cells.at(-1) !== expected) {
      failures.push(`\`${indexPath}\` gives ${shown} the status "${cells.at(-1)}", but its record says "${expected}". The record states it: write the row from there.`);
    }
  }
}

/** Rule 10: every generated block matches its source, which is here. */
function checkGenerated(root, tracked, failures) {
  const read = (path) => {
    if (!tracked.includes(path) || !existsSync(join(root, path))) throw new DocsError(`${path} is not here`);
    return readFileSync(join(root, path), "utf8");
  };
  for (const file of tracked.filter((p) => p.endsWith(".md") && existsSync(join(root, p)))) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("<!-- generated:")) continue;
    try {
      const { stale } = regenerate(text, read, file);
      if (stale.length > 0) failures.push(`\`${file}\` has generated block(s) its source no longer says: ${stale.join(", ")}. Run node scripts/generate-docs.mjs.`);
    } catch (err) {
      if (!(err instanceof DocsError)) throw err;
      failures.push(`${err.message}. A generated block must name a source this project keeps.`);
    }
  }
}

/** Every way a Claude Code settings object's hooks are malformed or name a file that is not tracked. */
export function hookProblems(settings, tracked) {
  const problems = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} is not a list`);
      continue;
    }
    for (const [i, group] of groups.entries()) {
      for (const [j, hook] of (Array.isArray(group?.hooks) ? group.hooks : [null]).entries()) {
        const at = `hooks.${event}[${i}].hooks[${j}]`;
        if (hook?.type !== "command" || typeof hook.command !== "string" || hook.command.trim() === "") {
          problems.push(`${at} is not {"type": "command", "command": …}`);
          continue;
        }
        for (const match of hook.command.matchAll(/\$\{?CLAUDE_PROJECT_DIR\}?\/([^\s"']+)/g)) {
          if (!tracked.includes(match[1])) problems.push(`${at} runs ${match[1]}, which is not tracked`);
        }
      }
    }
  }
  return problems;
}

export const VENDOR_DIRS = [
  // An agent file is chosen by name; a prompt file is chosen by its filename, so it needs no name field.
  { dir: ".github/agents", suffix: ".agent.md", requires: ["name", "description"] },
  { dir: ".github/prompts", suffix: ".prompt.md", requires: ["description"] },
];
export const SKILLS_DIR = ".claude/skills";
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCS_DIR = "docs";
const INDEX = "README.md";
const ADR_DIR = `${DOCS_DIR}/adr`;

const normalize = (text) => text.replace(/\r\n/g, "\n");

/** The leading `--- … ---` block, as single-line `key: value` pairs. Null when there is none. */
export function frontmatter(text) {
  const body = normalize(text);
  if (!body.startsWith("---\n")) return null;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return null;
  const fields = {};
  for (const line of body.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

/** A Markdown link whose target is exactly this path, with or without a leading `./`. */
export const linksTo = (text, target) =>
  new RegExp(`\\]\\(\\.?/?${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(text);

function checkSkills(root, tracked, failures) {
  const skills = new Map();
  for (const path of tracked.filter((p) => p.endsWith("SKILL.md"))) {
    const parts = path.split("/");
    if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== SKILLS_DIR) {
      failures.push(`\`${path}\` is a skill outside \`${SKILLS_DIR}/<name>/SKILL.md\`, where nothing will look for it.`);
      continue;
    }
    skills.set(parts[2], path);
  }
  for (const name of new Set(tracked.filter((p) => p.startsWith(`${SKILLS_DIR}/`)).map((p) => p.split("/")[2]))) {
    if (!skills.has(name)) failures.push(`\`${SKILLS_DIR}/${name}\` has no SKILL.md, so nothing in it is ever read.`);
  }
  for (const [name, path] of skills) {
    const fields = frontmatter(readFileSync(join(root, path), "utf8"));
    if (fields === null) {
      failures.push(`\`${path}\` has no frontmatter. A skill is selected on its name and description before it is opened.`);
      continue;
    }
    if (fields.name !== name) {
      failures.push(`\`${path}\` declares name \`${fields.name ?? ""}\`, but lives in \`${name}\`. The directory is what is invoked.`);
    } else if (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME) {
      failures.push(`\`${path}\` name \`${name}\` must be lowercase words joined by hyphens, at most ${MAX_SKILL_NAME} characters.`);
    }
    const description = fields.description ?? "";
    if (description === "") failures.push(`\`${path}\` has no description, so an agent cannot tell when to use it.`);
    else if (description.length > MAX_SKILL_DESCRIPTION) {
      failures.push(`\`${path}\` description is ${description.length} characters, over the ${MAX_SKILL_DESCRIPTION} the loader accepts.`);
    }
  }
  return skills.size;
}

/**
 * Every Markdown link that points at a path, with the line it sits on.
 *
 * Code is skipped, both fenced blocks and inline spans: a page that documents link syntax, or shows
 * a command containing brackets, is not making a link, and a checker that cannot tell the difference
 * teaches people to ignore it.
 */
export function markdownLinks(text) {
  const links = [];
  let fenced = false;
  normalize(text).split("\n").forEach((raw, index) => {
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, "");
    for (const [, target] of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ target, line: index + 1 });
    }
  });
  return links;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function checkLinks(root, tracked, failures) {
  let checked = 0;
  for (const file of tracked.filter((p) => p.endsWith(".md"))) {
    for (const { target, line } of markdownLinks(readFileSync(join(root, file), "utf8"))) {
      if (EXTERNAL.test(target)) continue;
      const [path] = target.split("#");
      if (path === "") continue;
      checked++;
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // A target that is not valid percent-encoding is checked as written.
      }
      const resolved = join(root, dirname(file), decoded);
      const inside = relative(root, resolved);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        // It may resolve on the author's disk; on GitHub, and in every clone, it goes nowhere.
        failures.push(`\`${file}:${line}\` links to \`${target}\`, outside the repository. Link to something in it, or use a full URL.`);
      } else if (!existsSync(resolved)) {
        failures.push(`\`${file}:${line}\` links to \`${target}\`, which does not exist. A link nobody can follow is worse than no link.`);
      }
    }
  }
  return checked;
}

function checkVendorFiles(root, tracked, failures) {
  for (const { dir, suffix, requires } of VENDOR_DIRS) {
    for (const path of tracked.filter((p) => p.startsWith(`${dir}/`))) {
      if (!path.endsWith(suffix)) {
        failures.push(`\`${path}\` is under \`${dir}/\` but is not a \`${suffix}\` file, so nothing loads it.`);
        continue;
      }
      const text = readFileSync(join(root, path), "utf8");
      const fields = frontmatter(text);
      const missing = requires.filter((field) => !(fields ?? {})[field]);
      if (missing.length > 0) {
        failures.push(`\`${path}\` needs frontmatter with ${missing.join(" and ")}; that is what it is selected on.`);
      }
      if (!text.includes(CANONICAL)) {
        failures.push(`\`${path}\` never names ${CANONICAL}. These files wrap a task; the rules stay in one place.`);
      }
    }
  }
}

function checkDocsTree(root, tracked, failures) {
  const docs = tracked.filter((p) => p.startsWith(`${DOCS_DIR}/`) && p.endsWith(".md"));
  if (docs.length === 0) return 0;
  const byDir = new Map();
  for (const path of docs) {
    const dir = dirname(path).split("\\").join("/");
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path.slice(dir.length + 1));
  }
  const rootIndex = byDir.has(DOCS_DIR) && byDir.get(DOCS_DIR).includes(INDEX) ? readFileSync(join(root, DOCS_DIR, INDEX), "utf8") : "";
  for (const [dir, names] of byDir) {
    if (!names.includes(INDEX)) {
      failures.push(`\`${dir}/\` has no ${INDEX}. Every directory of documents carries the index saying what is in it.`);
      continue;
    }
    const index = readFileSync(join(root, dir, INDEX), "utf8");
    const missing = names.filter((name) => name !== INDEX && !linksTo(index, name));
    if (missing.length > 0) {
      failures.push(`\`${dir}/${INDEX}\` does not link ${missing.map((n) => `\`${n}\``).join(", ")}. Add the entry with the page, or delete the page.`);
    }
    if (dir === DOCS_DIR) continue;
    const relative = `${dir.slice(DOCS_DIR.length + 1)}/${INDEX}`;
    if (!linksTo(rootIndex, relative)) {
      failures.push(`\`${DOCS_DIR}/${INDEX}\` does not link \`${relative}\`, so that directory is reachable only by guessing.`);
    }
  }
  return docs.length;
}

export function checkDocs(root = process.cwd()) {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0").filter(Boolean).filter((p) => existsSync(join(root, p)));
  } catch (err) {
    return { ok: false, fatal: `cannot list tracked files; is this a git repository? ${String(err.message).split("\n")[0]}` };
  }
  const failures = [];
  const read = (path) => readFileSync(join(root, path), "utf8");

  const canonical = tracked.filter((p) => p === CANONICAL || p.endsWith(`/${CANONICAL}`));
  if (!canonical.includes(CANONICAL)) failures.push(`\`${CANONICAL}\` is missing or untracked. It is where the instructions live.`);
  else if (read(CANONICAL).trim() === "") failures.push(`\`${CANONICAL}\` is empty.`);
  const nested = canonical.filter((p) => p !== CANONICAL);
  if (nested.length > 0) failures.push(`${nested.join(", ")} also claim to be agent instructions. Keep one file; the second copy is what drifts.`);

  // A case-insensitive filesystem will happily track `agents.md`, and the tools that look for the
  // exact name will not find it. The singular `AGENT.md` is the same mistake with a different spelling.
  for (const path of tracked) {
    const name = path.split("/").pop();
    const upper = name.toUpperCase();
    if (upper === WRONG_NAME) {
      failures.push(`\`${path}\` is the singular name; tools read \`${CANONICAL}\`. Rename it, or its contents are instructions nobody loads.`);
    } else if ((upper === CANONICAL.toUpperCase() && name !== CANONICAL) || (upper === IMPORT_FILE.toUpperCase() && name !== IMPORT_FILE)) {
      failures.push(`\`${path}\` differs from \`${CANONICAL}\`/\`${IMPORT_FILE}\` only in case. A case-insensitive filesystem hides that; the tools looking for the exact name do not.`);
    }
  }

  if (!tracked.includes(IMPORT_FILE)) failures.push(`\`${IMPORT_FILE}\` is missing or untracked. It must import ${CANONICAL}.`);
  else if (normalize(read(IMPORT_FILE)) !== IMPORT_TEXT) {
    failures.push(`\`${IMPORT_FILE}\` must be exactly \`${IMPORT_TEXT.trim()}\` and nothing else, so it cannot disagree with ${CANONICAL}.`);
  }

  for (const pointer of POINTERS) {
    if (!tracked.includes(pointer)) {
      failures.push(`\`${pointer}\` is missing or untracked. Without it that assistant reads no instructions at all.`);
      continue;
    }
    const text = read(pointer);
    if (!text.includes(CANONICAL)) {
      failures.push(`\`${pointer}\` never names ${CANONICAL}, so it is a second set of instructions rather than a pointer to the one set.`);
    }
    const count = normalize(text).trimEnd().split("\n").length;
    if (count > MAX_POINTER_LINES) {
      failures.push(`\`${pointer}\` is ${count} lines, over ${MAX_POINTER_LINES}. Instructions belong in ${CANONICAL}; this file says where to look.`);
    }
  }

  checkVendorFiles(root, tracked, failures);
  checkGenerated(root, tracked, failures);
  checkAdrIndex(root, tracked, failures);
  checkAdrRelations(root, tracked, failures);
  if (tracked.includes(CLAUDE_SETTINGS)) {
    try {
      failures.push(...hookProblems(JSON.parse(read(CLAUDE_SETTINGS)), tracked).map((problem) => `\`${CLAUDE_SETTINGS}\` ${problem}.`));
    } catch (err) {
      failures.push(`\`${CLAUDE_SETTINGS}\` is not valid JSON: ${err.message}. Claude Code ignores a settings file it cannot read, hooks and all.`);
    }
  }
  const skillCount = checkSkills(root, tracked, failures);
  const docCount = checkDocsTree(root, tracked, failures);
  const linkCount = checkLinks(root, tracked, failures);
  return { ok: failures.length === 0, failures, skillCount, docCount, linkCount };
}

function main() {
  const result = checkDocs(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (result.fatal) {
    console.error(`check-docs: ${result.fatal}`);
    return 2;
  }
  if (!result.ok) {
    console.error(`check-docs: ${result.failures.length} problem(s)\n`);
    for (const failure of result.failures) console.error(`  ${failure}\n`);
    return 1;
  }
  console.log(`check-docs: OK. ${result.docCount} documents indexed, ${result.skillCount} skill(s), ${result.linkCount} link(s) resolve.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
