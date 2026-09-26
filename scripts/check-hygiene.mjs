/**
 * Repository hygiene: the SHAPE of the repository, which no test of its content can see.
 *
 * Each rule guards against a failure an ordinary build walks straight past — a .gitignore emptied by
 * an automated commit, thousands of dependency files tracked in a single change:
 *
 *   1. .gitignore still carries the rules whose absence is expensive, and has not been truncated.
 *   2. Nothing under a dependency directory is tracked, at any depth: every module has its own.
 *   3. No tracked file exceeds MAX_TRACKED_BYTES. Git keeps every blob forever.
 *   4. Every tracked .json parses. A truncated lockfile stops `npm ci` in CI, while `npm install`
 *      repairs it silently on every laptop.
 *   5. No tracked file is also ignored: it stays tracked today and cannot be re-added tomorrow.
 *   6. No environment file is tracked. Real credentials live outside the repository.
 *   7. Once template/ is gone, no template marker line survives.
 *   8. Workflows and local actions pin every third-party action to a full commit SHA; every
 *      workflow declares `permissions:` and every job a `timeout-minutes`; a step that starts a
 *      detached container removes it with a `trap` on exit, or on a reused self-hosted runner the
 *      container outlives the job and keeps its name and port from the next run. Every npm install in a
 *      workflow, local action or Dockerfile passes --ignore-scripts: a dependency's install script is
 *      how npm worms run code on the machine that installs them.
 *   9. Every job in verify.yml is listed under the aggregate `verify` job's `needs`. A job left out
 *      still runs and still shows red, but no longer blocks a merge — and nothing says so.
 *  10. No tracked source or config file contains a raw control character. A raw NUL makes git treat
 *      the whole file as binary: its diffs collapse to "Bin", so the change is never reviewed.
 *  11. No tracked source or config file contains an invisible or text-reordering character. A human
 *      reviewer sees nothing where an agent reads a hidden instruction, or code runs other than shown.
 *  12. No tracked source or config file holds an absolute path into someone's home directory.
 *  13. Every module's module.json is valid, and the module tracks the manifest and lockfile its
 *      toolchain installs from, has every `npm run` script its module.json names, a verify.yml job
 *      named after it, and a dependabot.yml entry for its directory. Deleting the job or the entry
 *      leaves everything green while CI stops checking the module and its dependencies stop moving.
 *      A toolchain manifest (package.json, go.mod, pyproject.toml) below the root with no module.json
 *      beside it or above it fails too: nothing would install or verify it.
 *  14. Every Dockerfile `FROM` names its base image by digest. A tag can be repointed at a different
 *      image with no diff here, the exposure ADR-0003 pins actions against.
 *  15. A download in a workflow or local action that keeps a file is verified against a checksum in
 *      the same step, and no download is piped into an interpreter, which runs it before anything
 *      could check it.
 *  16. No workflow or local action writes a version of its own: a tool version (`X_VERSION:`, `@vX.Y.Z`,
 *      `==X.Y.Z`, a release download, `version: vX`) belongs in scripts/tools/tools.json, and a toolchain
 *      version (`node-version: 24`) in the file its setup action reads. A pin written anywhere else is
 *      one the pin report and the installer cannot see.
 *  17. Every copy of a toolchain version agrees with the file that declares it: `.node-version` for
 *      `engines`, the `@types/node` major, `node` base images and the Dev Container's node feature;
 *      `go.mod` for `golang` base images and the go feature; `.python-version` for `python` base images
 *      and the python feature, within `requires-python`, whose floor is mypy's `python_version`. The Dev
 *      Container installs no tool at a version scripts/tools/tools.json does not pin, uv's pin satisfies
 *      `required-version`, and every Node module pins one Biome. A copy nothing compares drifts, and the
 *      image or the Dev Container then runs a toolchain CI never proved.
 *  18. A job that calls a workflow in this repository grants at least every permission that workflow's
 *      jobs ask for. GitHub refuses to start a run whose call grants less, before any `if:` is read, so
 *      the caller fails on every push while nothing on the pull request can see it.
 *
 *   node scripts/check-hygiene.mjs
 *
 * Exit 0 clean · 1 a rule is broken · 2 the repository cannot be inspected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANIFEST, TOOLCHAINS, validateManifest } from "./modules.mjs";
import { TOOLS_PATH } from "./tools.mjs";

export const REQUIRED_IGNORES = ["node_modules/", "dist/", "coverage/", ".env", ".env.*"];
/** Below this the file was truncated, not edited. */
export const MIN_RULES = 10;
export const FORBIDDEN_TRACKED_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];
export const MAX_TRACKED_BYTES = 4 * 1024 * 1024;
/** Read by tools that accept comments; every other .json must be strict JSON. */
export const JSONC = /(^|\/)(tsconfig(\.[\w-]+)?\.json|devcontainer\.json)$|(^|\/)\.vscode\//;
export const MARKER = /ultra:(?:begin|end)\s+[a-z0-9-]+/;

const TEXT_SOURCE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|go|py|toml|sh|ya?ml|jsonc?|md|c4|css|html)$/;
// Tab, LF and CR are the only C0 characters text needs; anything else belongs in an escape.
const CONTROL_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
// Characters that render as nothing, or reorder what is shown, while a program — or an agent — still
// reads them: zero-width characters and invisible operators, bidirectional controls (Trojan Source),
// variation selectors, byte-order marks, invisible fillers, and the Unicode tag block, which carries
// whole hidden sentences ("ASCII smuggling"). Emoji are the exception: the presentation selector after a
// pictograph or keycap (as in a warning sign or a heart) and the joiner inside an emoji sequence are how
// ordinary emoji are spelt, so only a selector or joiner standing anywhere else is flagged.
// Written as escapes so this file contains none of them.
export const INVISIBLE_CHAR = /[\u200B\u200C\u2060-\u2064\u202A-\u202E\u2066-\u2069\uFE00-\uFE0D\uFEFF\u180E\u115F\u1160\u3164\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|(?<![\p{Extended_Pictographic}0-9#*])[\uFE0E\uFE0F]|(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/u;
// An absolute path into one person's home directory on macOS or Windows: it names them, and works on no
// other machine. /home/<name> is not matched, because containers use it too (/home/node in a Dev Container
// mount, /home/app in a compose file), and there it is configuration, not someone's machine.
export const PERSONAL_PATH = /(?:^|[^\w.-])(?:\/Users\/|[A-Za-z]:[\\/]Users[\\/])[A-Za-z][\w.-]*/;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EXAMPLE = /(^|\/)\.env\.example$/;
const WORKFLOW = /^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/;
const USES = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const DETACHED = /\bdocker run\b(?=.*\s--detach\b)(?=.*\s--name[ =]([\w.-]+))/;
const NPM_INSTALL = /\bnpm\s+(?:ci|install|i)\b/;

/** Rule 8, installs: npm never runs a dependency's install scripts in CI or an image build. */
export function checkInstalls(path, text) {
  return text.split(/\r?\n/).flatMap((line, i) =>
    !/^\s*#/.test(line) && NPM_INSTALL.test(line) && !line.includes("--ignore-scripts")
      ? [`${path}:${i + 1} installs with npm without --ignore-scripts, so any dependency's install script runs.`]
      : []);
}

/**
 * Rule 13. A module whose lockfile is missing still installs (setup.mjs falls back to its toolchain's
 * unlocked install, which is how a new module's lockfile is first written), but from then on every
 * machine and every CI run resolves its own dependency tree, and nothing says so. This rule is what
 * makes that fallback safe to keep: the module cannot be committed without the lockfile it produced.
 */
export function checkModules(tracked, read) {
  const failures = [];
  // Read only when tracked: deleting either file is a decision, and a rule that crashed on it would
  // report the wrong thing.
  const jobs = tracked.includes(GATE) ? jobIds(read(GATE)) : null;
  const updated = tracked.includes(DEPENDABOT) ? dependabotDirectories(read(DEPENDABOT)) : null;
  const manifests = tracked.filter((path) => path.endsWith(`/${MANIFEST}`));
  const dirs = manifests.map((path) => path.slice(0, -MANIFEST.length - 1));
  const ids = new Map();
  for (const [i, path] of manifests.entries()) {
    const dir = dirs[i];
    let module;
    // Rule 4 reports a manifest that does not parse; this rule says nothing more about it.
    try {
      module = JSON.parse(read(path));
    } catch {
      continue;
    }
    const problems = validateManifest(module, path);
    if (problems.length > 0) {
      failures.push(...problems.map((problem) => `${problem}.`));
      continue;
    }
    if (ids.has(module.id)) failures.push(`\`${path}\` and \`${ids.get(module.id)}\` both name the module \`${module.id}\`.`);
    ids.set(module.id, path);
    const toolchain = TOOLCHAINS[module.toolchain];
    for (const file of [toolchain.manifest, toolchain.lockfile].filter(Boolean)) {
      if (!tracked.includes(`${dir}/${file}`)) {
        failures.push(`\`${dir}\` is present but does not track \`${file}\`, so it installs a dependency tree nothing pins.`);
      }
    }
    if (jobs !== null && !jobs.includes(module.id)) {
      failures.push(`\`${dir}\` is present but \`verify.yml\` has no \`${module.id}\` job, so CI never runs its checks.`);
    }
    if (updated !== null && !updated.includes(`/${dir}`)) {
      failures.push(`\`${DEPENDABOT}\` has no entry for \`/${dir}\`, so its dependencies are never proposed for update.`);
    }
    if (module.toolchain !== "node" || !tracked.includes(`${dir}/package.json`)) continue;
    let scripts;
    try {
      scripts = JSON.parse(read(`${dir}/package.json`)).scripts ?? {};
    } catch {
      continue;
    }
    for (const script of npmScripts(module)) {
      if (!(script in scripts)) failures.push(`\`${path}\` runs \`npm run ${script}\`, which \`${dir}/package.json\` does not define.`);
    }
  }
  // A module nothing declares is a module nothing installs or verifies, while it looks like part of the build.
  const manifestNames = new Set(Object.values(TOOLCHAINS).map((t) => t.manifest));
  for (const path of tracked) {
    const at = path.lastIndexOf("/");
    if (at === -1 || !manifestNames.has(path.slice(at + 1))) continue;
    const dir = path.slice(0, at);
    if (!dirs.some((moduleDir) => dir === moduleDir || dir.startsWith(`${moduleDir}/`))) {
      failures.push(`\`${path}\` looks like a module, but no \`${MANIFEST}\` declares it, so nothing installs or verifies it.`);
    }
  }
  return failures;
}

/** The npm scripts a module's manifest runs, from its checks, coverage and facts commands. */
function npmScripts(module) {
  const commands = [...module.checks.flatMap((c) => [c.run, c.otherwise?.run]), ...(module.coverage?.run ?? []), module.facts?.run].filter(Boolean);
  return commands.filter((c) => c[0] === "npm" && c[1] === "run").map((c) => c.slice(2).find((arg) => !arg.startsWith("-")));
}

const GATE = ".github/workflows/verify.yml";
const DEPENDABOT = ".github/dependabot.yml";

/** The directories dependabot.yml updates, from `directory:` and from `directories:` lists. */
function dependabotDirectories(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*(?:-\s*)?directory:\s*["']?([^"'\s#]+)/.exec(line) ?? /^\s*-\s*["']?(\/[^"'\s#]*)/.exec(line);
    if (entry) found.push(entry[1].length > 1 ? entry[1].replace(/\/$/, "") : entry[1]);
  }
  return found;
}

/** The job ids of a workflow, in the two-space layout this repository writes. */
export function jobIds(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const ids = [];
  for (let i = start + 1; start !== -1 && i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break;
    const opened = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (opened) ids.push(opened[1]);
  }
  return ids;
}

/** Rule 14. Stage aliases and `scratch` name no image; anything else must carry a full digest. */
export function checkDigests(path, text) {
  const problems = [];
  const stages = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    const from = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!from) return;
    const words = from[1].trim().split(/\s+/).filter((w) => !w.startsWith("--"));
    const [image = "", keyword, alias] = words;
    if (keyword?.toLowerCase() === "as" && alias) stages.add(alias.toLowerCase());
    if (image.toLowerCase() === "scratch" || stages.has(image.toLowerCase()) && image.toLowerCase() !== alias?.toLowerCase()) return;
    if (image.includes("$")) {
      problems.push(`${path}:${i + 1} names its base image through \`${image}\`, so no digest can be checked. Write the image with \`@sha256:\`.`);
    } else if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      problems.push(`${path}:${i + 1} names base image \`${image}\` by tag alone. Add its digest (\`@sha256:…\`): a tag can be repointed.`);
    }
  });
  return problems;
}

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python3", "node", "perl", "ruby", "pwsh"]);
// A download piped into one of these is written to disk, and so is a file to verify.
const UNPACKERS = new Set(["tar", "unzip", "tee", "cpio", "gunzip", "bsdtar"]);
const CHECKSUM = /\b(?:sha256sum|shasum)\b/;
const WORDS = /"[^"]*"|'[^']*'|\S+/g;
const nowhere = (target) => target === "-" || target === "/dev/null" || target.startsWith("&");

/**
 * What one downloader command does with what it fetches: "file" when it keeps one, "pipe:<cmd>" when
 * it feeds an interpreter, or null. `words` is one pipeline stage; `rest` are the stages after it.
 */
function downloadEffect(words, rest) {
  const tool = words[0];
  let keeps = tool === "wget";
  let wgetTarget = null;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const redirect = /^1?>>?(.*)$/.exec(word);
    if (redirect) {
      const target = redirect[1] || words[i + 1] || "";
      if (!nowhere(target)) keeps = true;
      continue;
    }
    if (tool === "curl") {
      if (word === "-o" || word === "--output") keeps ||= !nowhere(words[i + 1] ?? "-");
      else if (word.startsWith("--output=")) keeps ||= !nowhere(word.slice(9));
      else if (word === "--remote-name" || word === "--remote-name-all") keeps = true;
      else if (/^-[A-Za-z]+$/.test(word)) {
        if (word.includes("O")) keeps = true;
        if (word.endsWith("o")) keeps ||= !nowhere(words[i + 1] ?? "-");
      }
    } else {
      const short = /^-[A-Za-z]*O(.*)$/.exec(word);
      if (short) wgetTarget = short[1] || words[i + 1] || "";
      else if (word === "--output-document") wgetTarget = words[i + 1] ?? "";
      else if (word.startsWith("--output-document=")) wgetTarget = word.slice(18);
    }
  }
  if (wgetTarget !== null && nowhere(wgetTarget)) keeps = false;
  for (const stage of rest) {
    const command = stage.find((w) => w !== "sudo" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !w.startsWith("-"));
    if (command === undefined) continue;
    const name = command.split("/").at(-1);
    if (INTERPRETERS.has(name)) return `pipe:${name}`;
    if (UNPACKERS.has(name)) keeps = true;
  }
  return keeps ? "file" : null;
}

// Words that may stand before a command: the YAML item and key, shell keywords, and env assignments.
const PREFIX = /^(?:-|run:|if|then|do|else|!|sudo|time|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;
/** Where curl or wget starts in a pipeline stage, or -1 when the stage does not run one. */
function downloader(stage) {
  const at = stage.findIndex((word) => word === "curl" || word === "wget");
  return at !== -1 && stage.slice(0, at).every((word) => PREFIX.test(word)) ? at : -1;
}

// Lines shaped like a version written by hand. `uses:` lines are rule 8's, and are skipped.
const PIN_SHAPED = [
  [/^\s*[A-Z][A-Z0-9_]*_VERSION:\s*["']?v?\d/, "a tool version in an environment variable"],
  [/@v\d+\.\d+\.\d+/, "a tool run at a version"],
  [/==\d+\.\d+\.\d+/, "a package pinned to a version"],
  [/\/releases\/download\/v?\d/, "a release downloaded by version"],
  [/^\s+version:\s*["']?v?\d/, "a version input"],
  [/^\s+(?:node|go|python|java|ruby|dotnet)-version:\s*["']?\d/, "a toolchain version"],
];

/** Rule 16, for one workflow or action file. */
export function checkPins(path, text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line) || /^\s*-?\s*uses:/.test(line)) return;
    const found = PIN_SHAPED.find(([shape]) => shape.test(line));
    if (found) {
      problems.push(`${path}:${i + 1} writes ${found[1]} (\`${line.trim()}\`). Pin a tool in scripts/tools/tools.json and read it with scripts/tools.mjs; read a toolchain version from its file (node-version-file, go-version-file).`);
    }
  });
  return problems;
}

/** Rule 15, for one workflow or action file. A step is the YAML list item a line sits in. */
export function checkDownloads(path, text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const indent = (line) => line.length - line.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i]) || !/(?:^|[\s;&|(`])(?:curl|wget)\s/.test(lines[i])) continue;
    let command = lines[i];
    for (let j = i; /\\\s*$/.test(lines[j]) && j + 1 < lines.length; j++) command = `${command.replace(/\\\s*$/, " ")}${lines[j + 1]}`;
    let start = i;
    while (start > 0 && !/^\s*- /.test(lines[start])) start--;
    const depth = indent(lines[start]);
    let end = start + 1;
    while (end < lines.length && !(lines[end].trim() !== "" && (indent(lines[end]) < depth || indent(lines[end]) === depth && /^\s*- /.test(lines[end])))) end++;
    const verified = lines.slice(start, end).some((l) => !/^\s*#/.test(l) && CHECKSUM.test(l));
    for (const segment of command.split(/&&|\|\||;/)) {
      const stages = segment.split("|").map((stage) => stage.match(WORDS) ?? []);
      const at = stages.findIndex((stage) => downloader(stage) !== -1);
      if (at === -1) continue;
      const words = stages[at].slice(downloader(stages[at]));
      const effect = downloadEffect(words, stages.slice(at + 1));
      if (effect?.startsWith("pipe:")) {
        problems.push(`${path}:${i + 1} pipes a download into \`${effect.slice(5)}\`, which runs it before anything can check it. Download to a file, verify its checksum, then run it.`);
      } else if (effect === "file" && !verified) {
        problems.push(`${path}:${i + 1} downloads a file with no checksum in the same step. Verify it with \`sha256sum -c\` against the digest the release publishes.`);
      }
    }
  }
  return problems;
}

/**
 * Where each toolchain declares its version (a file whose directory it governs), how many leading
 * numbers are the version that matters (Node: the major; Go and Python: major.minor), the official
 * image that carries it, and the Dev Container feature that installs it.
 */
export const TOOLCHAIN_VERSIONS = {
  node: { name: "Node", file: /(^|\/)\.node-version$/, read: (text) => text.trim(), parts: 1, image: "node", feature: "node" },
  go: { name: "Go", file: /(^|\/)go\.mod$/, read: (text) => /^go\s+(\S+)/m.exec(text)?.[1] ?? "", parts: 2, image: "golang", feature: "go" },
  python: { name: "Python", file: /(^|\/)\.python-version$/, read: (text) => text.trim(), parts: 2, image: "python", feature: "python" },
};
const DEVCONTAINER = /(^|\/)\.?devcontainer\.json$/;
const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** The first `parts` numbers of the first version in `text` ("^24.13.5" → "24"), or null when it has fewer. */
export function leadingVersion(text, parts) {
  const numbers = /\d+(?:\.\d+)*/.exec(String(text ?? ""))?.[0].split(".") ?? [];
  return numbers.length >= parts ? numbers.slice(0, parts).map(Number).join(".") : null;
}

const numbers = (version) => version.split(".").map(Number);
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Whether `version` falls inside a PEP 440 specifier such as ">=0.12.5,<0.13". Throws on a clause it cannot read. */
export function satisfies(version, specifier) {
  const v = numbers(version);
  return specifier.split(",").map((clause) => clause.trim()).filter(Boolean).every((clause) => {
    const parsed = /^(~=|===|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause);
    if (!parsed) throw new Error(`cannot read the version specifier \`${clause}\``);
    const [, op, bound, wildcard] = parsed;
    const b = numbers(bound);
    if (wildcard) {
      const same = compare(v.slice(0, b.length), b) === 0;
      if (op === "==") return same;
      if (op === "!=") return !same;
      throw new Error(`\`${clause}\`: only == and != take a wildcard`);
    }
    const order = compare(v, b);
    if (op === "~=") return b.length > 1 && order >= 0 && compare(v.slice(0, b.length - 1), b.slice(0, -1)) === 0;
    return { "==": order === 0, "===": order === 0, "!=": order !== 0, "<=": order <= 0, ">=": order >= 0, "<": order < 0, ">": order > 0 }[op];
  });
}

/** The lowest version a PEP 440 specifier admits through its `>=` or `~=` bound, or null when it has none. */
export function specifierFloor(specifier) {
  const floors = [...specifier.matchAll(/(?:>=|~=)\s*(\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  return floors.sort((a, b) => compare(numbers(b), numbers(a)))[0] ?? null;
}

/** A string value from one TOML table, read line by line: enough for the flat keys rule 17 compares. */
export function tomlString(text, table, key) {
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    const entry = /^\s*("[^"]*"|[\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (current === table && entry && entry[1].replaceAll('"', "") === key) return entry[2] ?? entry[3];
  }
  return null;
}

/** Parses JSON with comments and trailing commas, as devcontainer.json and tsconfig.json are written. */
export function parseJsonc(text) {
  // Two passes, each copying strings whole: comments go first, so a trailing comma is found even when a
  // comment stands between it and the bracket.
  const pass = (input, visit) => {
    let out = "";
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '"') {
        let end = i + 1;
        while (end < input.length && input[end] !== '"') end += input[end] === "\\" ? 2 : 1;
        out += input.slice(i, end + 1);
        i = end;
      } else {
        const skip = visit(input, i);
        if (skip === null) out += input[i];
        else [i, out] = [skip.to, out + skip.with];
      }
    }
    return out;
  };
  const bare = pass(text, (input, i) => {
    if (input.startsWith("//", i)) {
      const end = input.indexOf("\n", i);
      return { to: (end === -1 ? input.length : end) - 1, with: "" };
    }
    if (input.startsWith("/*", i)) {
      const end = input.indexOf("*/", i + 2);
      return { to: end === -1 ? input.length : end + 1, with: " " };
    }
    return null;
  });
  return JSON.parse(pass(bare, (input, i) => (input[i] === "," && /^\s*[}\]]/.test(input.slice(i + 1)) ? { to: i, with: "" } : null)));
}

/** The nearest declaration of a toolchain's version that governs `path`: its own directory or the closest above. */
function governing(sources, path) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return sources
    .filter((source) => source.dir === "" || dir === source.dir || dir.startsWith(`${source.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** The base images a Dockerfile names, as {line, name, tag}; stage aliases and `scratch` are left out. */
function baseImages(text) {
  const images = [];
  const stages = new Set(["scratch"]);
  text.split(/\r?\n/).forEach((line, i) => {
    const from = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!from) return;
    const [image = "", keyword, alias] = from[1].trim().split(/\s+/).filter((w) => !w.startsWith("--"));
    const reference = image.split("@")[0];
    const colon = reference.lastIndexOf(":");
    const named = colon > reference.lastIndexOf("/") ? reference.slice(0, colon) : reference;
    if (!stages.has(image.toLowerCase())) images.push({ line: i + 1, name: named.split("/").at(-1).toLowerCase(), tag: colon > reference.lastIndexOf("/") ? reference.slice(colon + 1) : null });
    if (keyword?.toLowerCase() === "as" && alias) stages.add(alias.toLowerCase());
  });
  return images;
}

/**
 * Rule 17. `tracked` are the files present; `read` returns one's text. Every copy of a toolchain
 * version, and every tool version the Dev Container installs, is compared with its one declaration.
 */
export function checkVersions(tracked, read) {
  const failures = [];
  const json = (path) => {
    try {
      return JSON.parse(read(path));
    } catch {
      return null; // rule 4 reports it
    }
  };
  const sources = Object.fromEntries(Object.entries(TOOLCHAIN_VERSIONS).map(([name, toolchain]) => [
    name,
    tracked.filter((path) => toolchain.file.test(path)).map((path) => {
      const at = path.lastIndexOf("/");
      const declared = toolchain.read(read(path));
      const version = leadingVersion(declared, toolchain.parts);
      if (version === null) failures.push(`\`${path}\` declares \`${declared}\`, which is not a ${toolchain.name} version this rule can compare.`);
      return { path, dir: at === -1 ? "" : path.slice(0, at), version };
    }).filter((source) => source.version !== null),
  ]));
  const differs = (where, what, found, toolchain, source) =>
    failures.push(`${where} ${what} ${found}, but \`${source.path}\` declares ${TOOLCHAIN_VERSIONS[toolchain].name} ${source.version}. Move every copy together (docs/toolchain-updates.md).`);

  // Node: engines, the @types/node major, and every Node module's Biome.
  const biome = new Map();
  for (const path of tracked.filter((p) => /(^|\/)package\.json$/.test(p))) {
    const manifest = json(path);
    if (manifest === null) continue;
    const node = governing(sources.node, path);
    if (node && manifest.engines?.node !== undefined && leadingVersion(manifest.engines.node, 1) !== node.version) {
      differs(`\`${path}\``, "requires Node", `\`${manifest.engines.node}\``, "node", node);
    }
    for (const key of DEPENDENCY_KEYS) {
      const types = manifest[key]?.["@types/node"];
      if (node && types !== undefined && leadingVersion(types, 1) !== node.version) {
        differs(`\`${path}\``, "types its code against @types/node", `\`${types}\``, "node", node);
      }
      const lint = manifest[key]?.["@biomejs/biome"];
      if (lint !== undefined) biome.set(path, lint);
    }
  }
  if (new Set(biome.values()).size > 1) {
    failures.push(`Biome is pinned at different versions: ${[...biome].map(([path, version]) => `\`${version}\` in \`${path}\``).join(", ")}. Every Node module lints and formats with one Biome, so pin one version everywhere.`);
  }

  // Base images: a toolchain's official image runs the version its governing declaration names.
  for (const path of tracked.filter((p) => /(^|\/)Dockerfile$/.test(p))) {
    for (const { line, name, tag } of baseImages(read(path))) {
      const [toolchain, spec] = Object.entries(TOOLCHAIN_VERSIONS).find(([, t]) => t.image === name) ?? [];
      const source = toolchain && governing(sources[toolchain], path);
      if (source && leadingVersion(tag, spec.parts) !== source.version) differs(`\`${path}:${line}\``, `builds on ${name}`, tag === null ? "with no tag" : `\`${tag}\``, toolchain, source);
    }
  }

  // Python: .python-version inside requires-python, mypy checking against its floor, uv inside required-version.
  const tools = tracked.includes(TOOLS_PATH) ? json(TOOLS_PATH)?.tools ?? {} : {};
  for (const path of tracked.filter((p) => /(^|\/)pyproject\.toml$/.test(p))) {
    const text = read(path);
    const requires = tomlString(text, "project", "requires-python");
    const mypy = tomlString(text, "tool.mypy", "python_version");
    const uvRange = tomlString(text, "tool.uv", "required-version");
    const python = governing(sources.python, path);
    try {
      if (requires !== null && python && !satisfies(python.version, requires)) {
        failures.push(`\`${python.path}\` declares Python ${python.version}, outside \`${path}\`'s requires-python \`${requires}\`.`);
      }
      const floor = requires === null ? null : specifierFloor(requires);
      if (mypy !== null && leadingVersion(mypy, 2) !== leadingVersion(floor, 2)) {
        failures.push(`\`${path}\` type-checks against Python ${mypy} ([tool.mypy] python_version), but its requires-python floor is ${floor ?? "not stated"}. mypy checks the oldest Python the package supports.`);
      }
      if (uvRange !== null && tools.uv && !satisfies(tools.uv.version, uvRange)) {
        failures.push(`\`${TOOLS_PATH}\` pins uv ${tools.uv.version}, outside \`${path}\`'s required-version \`${uvRange}\`, so the pinned uv refuses to run.`);
      }
    } catch (err) {
      failures.push(`\`${path}\`: ${err.message}.`);
    }
  }

  // The Dev Container: each toolchain feature at the declared version, each tool at its pin, and nothing unpinned.
  for (const path of tracked.filter((p) => DEVCONTAINER.test(p))) {
    let features;
    try {
      features = parseJsonc(read(path)).features ?? {};
    } catch (err) {
      failures.push(`\`${path}\` does not parse: ${err.message}`);
      continue;
    }
    for (const [id, value] of Object.entries(features)) {
      const feature = id.split("@")[0].replace(/:[^/:]*$/, "").split("/").at(-1);
      const options = typeof value === "string" ? { version: value } : value ?? {};
      const [toolchain, spec] = Object.entries(TOOLCHAIN_VERSIONS).find(([, t]) => t.feature === feature) ?? [];
      for (const source of toolchain ? sources[toolchain] : []) {
        if (leadingVersion(options.version, spec.parts) !== source.version) differs(`\`${path}\``, `installs ${spec.name} through \`${id}\` at`, options.version === undefined ? "the feature's default" : `\`${options.version}\``, toolchain, source);
      }
      for (const [name, tool] of Object.entries(tools)) {
        const option = tool.devcontainer?.[feature];
        if (option !== undefined && options[option] !== tool.version) {
          failures.push(`\`${path}\` installs ${name} through \`${id}\` at ${options[option] === undefined ? "the feature's default (latest)" : `\`${options[option]}\``}, but \`${TOOLS_PATH}\` pins ${tool.version}. Set \`${option}\` to ${tool.version}.`);
        }
      }
      // The python feature pipx-installs a list of tools (uv among them, when asked) at whatever is newest.
      if (feature === TOOLCHAIN_VERSIONS.python.feature && options.installTools !== false) {
        failures.push(`\`${path}\` lets \`${id}\` install its own tools, at unpinned versions. Set \`"installTools": false\`: uv comes from \`${TOOLS_PATH}\`, and the rest from each module's lockfile.`);
      }
    }
  }
  return failures;
}

export const containsDir = (path, dir) => path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);
export const ignoreRules = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

const git = (root, args, input) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

function trackedAndIgnored(root, paths) {
  if (paths.length === 0) return [];
  try {
    // --no-index is load-bearing: without it git reports a tracked path as not ignored even when a
    // pattern matches it, which is exactly the case this rule exists to find.
    return git(root, ["check-ignore", "--no-index", "--stdin", "-z"], `${paths.join("\0")}\0`).split("\0").filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // exit 1: no path matched, the clean case
    throw err;
  }
}

/** Rule 8 for one file. Reads the two-space layout this repository writes, not arbitrary YAML. */
export function checkWorkflow(path, text) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const ref = USES.exec(line)?.[1];
    if (ref === undefined || ref.startsWith("./") || ref.startsWith("docker://")) return;
    if (!PINNED.test(ref)) problems.push(`${path}:${i + 1} uses \`${ref}\`, which is not pinned to a 40-character commit SHA.`);
  });
  lines.forEach((line, i) => {
    const name = DETACHED.exec(line)?.[1];
    if (name === undefined) return;
    let step = i;
    while (step > 0 && !/^\s*- /.test(lines[step])) step--;
    const trapped = lines.slice(step, i).some((l) => /\btrap\b/.test(l) && l.includes(`docker rm --force ${name}`));
    if (!trapped) problems.push(`${path}:${i + 1} starts container \`${name}\` detached with no \`trap 'docker rm --force ${name}' EXIT\` before it.`);
  });
  problems.push(...checkInstalls(path, text));
  if (!path.includes("/workflows/")) return problems;

  if (!lines.some((l) => l.startsWith("permissions:"))) {
    problems.push(`${path} has no top-level \`permissions:\`, so every job gets the repository's default token scope.`);
  }
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  let job = null;
  const close = () => {
    if (job !== null && !job.timeout && !job.reusable) {
      problems.push(`${path}:${job.line} job \`${job.id}\` has no \`timeout-minutes\`; the default is six hours.`);
    }
  };
  for (let i = start + 1; start !== -1 && i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break;
    const opened = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (opened) {
      close();
      job = { id: opened[1], line: i + 1, timeout: false, reusable: false };
    } else if (job !== null) {
      if (/^ {4}timeout-minutes:/.test(line)) job.timeout = true;
      if (/^ {4}uses:/.test(line)) job.reusable = true;
    }
  }
  close();
  return problems;
}

const LEVELS = ["none", "read", "write"];

/**
 * The `permissions:` value on line `i`, whose key sits `indent` spaces in: each scope's level (0 none,
 * 1 read, 2 write), or `all` for read-all and write-all. Null when it is not written in a form read here.
 */
function permissionsAt(lines, i, indent) {
  const value = lines[i]
    .slice(lines[i].indexOf("permissions:") + "permissions:".length)
    .replace(/\s+#.*$/, "")
    .trim();
  if (value === "read-all" || value === "write-all") return { all: LEVELS.indexOf(value.slice(0, -"-all".length)) };
  const scopes = {};
  const add = (pair) => {
    const match = /^([a-z-]+):\s*(none|read|write)$/.exec(pair.trim());
    if (match) scopes[match[1]] = LEVELS.indexOf(match[2]);
    return match !== null;
  };
  if (value.startsWith("{")) {
    const inner = /^\{(.*)\}$/.exec(value)?.[1];
    if (inner === undefined) return null;
    const pairs = inner.split(",").filter((pair) => pair.trim() !== "");
    return pairs.every(add) ? { scopes } : null;
  }
  if (value !== "") return null;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*(#.*)?$/.test(lines[j])) continue;
    if (/^ */.exec(lines[j])[0].length <= indent) break;
    if (!add(lines[j].replace(/\s+#.*$/, ""))) return null;
  }
  return { scopes };
}

/** A workflow's top-level permissions, and each job's own and the workflow it calls. Same layout as checkWorkflow. */
export function workflowJobs(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("permissions:"));
  const top = at === -1 ? undefined : { line: at + 1, grant: permissionsAt(lines, at, 0) };
  const jobs = [];
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  for (let i = start + 1; start !== -1 && i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break;
    const opened = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (opened) jobs.push({ id: opened[1], line: i + 1 });
    else if (jobs.length > 0) {
      const uses = /^ {4}uses:\s*["']?([^"'\s]+)/.exec(line)?.[1];
      if (uses !== undefined) jobs.at(-1).uses = uses;
      if (/^ {4}permissions:/.test(line)) jobs.at(-1).permissions = { line: i + 1, grant: permissionsAt(lines, i, 4) };
    }
  }
  return { top, jobs };
}

/**
 * Rule 18 over every workflow, `{path: text}`. A called job runs with its own block, else its workflow's
 * top level, else what the call grants; the call grants the calling job's block, else its workflow's top
 * level. Only what a called job will run with is required, so this never fails a call GitHub accepts.
 */
export function checkCalledPermissions(workflows) {
  const problems = new Set();
  const parsed = Object.fromEntries(Object.entries(workflows).map(([path, text]) => [path, workflowJobs(text)]));
  const unreadable = (path, block) => `${path}:${block.line} has a \`permissions:\` block this check cannot read; write each scope as a \`scope: level\` line.`;
  for (const [path, { top, jobs }] of Object.entries(parsed)) {
    for (const job of jobs.filter((j) => j.uses?.startsWith("./.github/workflows/"))) {
      const target = job.uses.slice(2);
      const granted = job.permissions ?? top;
      // With no block anywhere, rule 8 already fails the workflow.
      if (granted === undefined) continue;
      if (granted.grant === null) {
        problems.add(unreadable(path, granted));
        continue;
      }
      const called = parsed[target];
      if (called === undefined) {
        problems.add(`${path}:${job.line} job \`${job.id}\` calls ${target}, which is not in the repository.`);
        continue;
      }
      const grants = (scope) => granted.grant.all ?? granted.grant.scopes[scope] ?? 0;
      for (const calledJob of called.jobs) {
        const asked = calledJob.permissions ?? called.top;
        if (asked === undefined) continue;
        if (asked.grant === null) {
          problems.add(unreadable(target, asked));
          continue;
        }
        const shortfalls =
          asked.grant.all !== undefined
            ? (granted.grant.all ?? -1) < asked.grant.all
              ? [[`${LEVELS[asked.grant.all]}-all`, granted.grant.all === undefined ? "only named scopes" : `\`${LEVELS[granted.grant.all]}-all\``]]
              : []
            : Object.entries(asked.grant.scopes)
                .filter(([scope, level]) => grants(scope) < level)
                .map(([scope, level]) => [`${scope}: ${LEVELS[level]}`, `\`${scope}: ${LEVELS[grants(scope)]}\``]);
        for (const [want, have] of shortfalls) {
          problems.add(
            `${path}:${job.line} job \`${job.id}\` calls ${target}, whose job \`${calledJob.id}\` asks for \`${want}\`, but the call grants ${have}. Grant it on the calling job: GitHub refuses to start the run otherwise, before any \`if:\` is read.`,
          );
        }
      }
    }
  }
  return [...problems];
}

/** Rule 9. Same layout assumption as checkWorkflow: jobs at two spaces, `needs` as a block list. */
export function checkGate(path, text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  const needs = [];
  let inGate = false;
  let inNeeds = false;
  for (let i = start + 1; start !== -1 && i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break;
    const opened = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (opened) {
      jobs.push(opened[1]);
      inGate = opened[1] === "verify";
      inNeeds = false;
    } else if (inGate && /^ {4}needs:\s*$/.test(line)) {
      inNeeds = true;
    } else if (inGate && /^ {4}\S/.test(line)) {
      inNeeds = false;
    } else if (inNeeds) {
      const item = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line);
      if (item) needs.push(item[1]);
    }
  }
  if (!jobs.includes("verify")) return [`${path} has no aggregate \`verify\` job, which branch protection requires.`];
  const outside = jobs.filter((job) => job !== "verify" && !needs.includes(job));
  return outside.length === 0
    ? []
    : [`${path}: job(s) ${outside.join(", ")} are missing from \`verify.needs\`, so they run but do not gate a merge.`];
}

export function checkRepoHygiene(root = process.cwd()) {
  if (!existsSync(join(root, ".gitignore"))) return { ok: false, fatal: ".gitignore is missing. Restore it from the last good revision." };
  let tracked;
  try {
    tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  } catch (err) {
    return { ok: false, fatal: `cannot list tracked files; is this a git repository? ${String(err.message).split("\n")[0]}` };
  }
  if (tracked.length === 0) {
    return { ok: false, fatal: "nothing is tracked yet, so every rule would pass without checking anything. Run `git add -A` first." };
  }
  const read = (path) => readFileSync(join(root, path), "utf8");
  const present = tracked.filter((p) => existsSync(join(root, p)));
  const failures = [];

  const rules = ignoreRules(read(".gitignore"));
  for (const rule of REQUIRED_IGNORES) {
    if (!rules.includes(rule)) failures.push(`.gitignore no longer carries \`${rule}\`. Removing it is a decision, not a cleanup.`);
  }
  if (rules.length < MIN_RULES) {
    failures.push(`.gitignore holds ${rules.length} rule(s), below the floor of ${MIN_RULES}: it was truncated, not edited.`);
  }

  for (const dir of FORBIDDEN_TRACKED_DIRS) {
    const hits = tracked.filter((p) => containsDir(p, dir));
    if (hits.length > 0) failures.push(`${hits.length} tracked file(s) under a \`${dir}\` directory, e.g. ${hits[0]}. Untrack with \`git rm -r --cached\`.`);
  }

  for (const path of present) {
    const bytes = statSync(join(root, path)).size;
    if (bytes > MAX_TRACKED_BYTES) {
      failures.push(`\`${path}\` is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_TRACKED_BYTES / 1048576} MB bound. Git keeps the blob even after a later commit removes it.`);
    }
  }

  for (const path of present.filter((p) => p.endsWith(".json") && !JSONC.test(p))) {
    try {
      JSON.parse(read(path));
    } catch (err) {
      failures.push(`\`${path}\` is not valid JSON: ${err.message}`);
    }
  }

  const ignored = trackedAndIgnored(root, tracked);
  if (ignored.length > 0) {
    failures.push(`${ignored.length} tracked file(s) are also ignored, e.g. ${ignored[0]}. Narrow the rule, or anchor it with a leading slash.`);
  }

  const envFiles = tracked.filter((p) => ENV_FILE.test(p) && !ENV_EXAMPLE.test(p));
  if (envFiles.length > 0) {
    failures.push(`environment file(s) tracked: ${envFiles.join(", ")}. Revoke any secret they held, then untrack them.`);
  }

  if (!existsSync(join(root, "template"))) {
    const leftovers = [];
    for (const path of present) {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      const line = bytes.toString("utf8").split("\n").findIndex((l) => MARKER.test(l));
      if (line !== -1) leftovers.push(`${path}:${line + 1}`);
    }
    if (leftovers.length > 0) failures.push(`template marker line(s) survived initialization: ${leftovers.join(", ")}.`);
  }

  for (const path of present.filter((p) => WORKFLOW.test(p))) {
    failures.push(...checkDownloads(path, read(path)), ...checkPins(path, read(path)), ...checkWorkflow(path, read(path)));
  }
  const workflows = present.filter((p) => WORKFLOW.test(p) && p.includes("/workflows/"));
  failures.push(...checkCalledPermissions(Object.fromEntries(workflows.map((p) => [p, read(p)]))));
  for (const path of present.filter((p) => /(^|\/)Dockerfile$/.test(p))) failures.push(...checkDigests(path, read(path)), ...checkInstalls(path, read(path)));
  failures.push(...checkModules(tracked, read));
  failures.push(...checkVersions(present, read));

  if (present.includes(GATE)) failures.push(...checkGate(GATE, read(GATE)));

  const withControl = [];
  for (const path of present.filter((p) => TEXT_SOURCE.test(p))) {
    const line = read(path).split("\n").findIndex((l) => CONTROL_CHAR.test(l));
    if (line !== -1) withControl.push(`${path}:${line + 1}`);
  }
  if (withControl.length > 0) {
    failures.push(`raw control character(s) in ${withControl.join(", ")}. Write them as escapes such as \\u0000: the value is the same, and the file stays text to git, grep and review.`);
  }

  const withInvisible = [];
  const withHomePath = [];
  for (const path of present.filter((p) => TEXT_SOURCE.test(p))) {
    const lines = read(path).split("\n");
    const invisible = lines.findIndex((l) => INVISIBLE_CHAR.test(l));
    if (invisible !== -1) withInvisible.push(`${path}:${invisible + 1}`);
    const home = lines.findIndex((l) => PERSONAL_PATH.test(l));
    if (home !== -1) withHomePath.push(`${path}:${home + 1}`);
  }
  if (withInvisible.length > 0) {
    failures.push(`invisible or text-reordering character(s) in ${withInvisible.join(", ")}. A reviewer cannot see them and an agent still reads them; delete them, or write them as escapes where one is really meant.`);
  }
  if (withHomePath.length > 0) {
    failures.push(`absolute path(s) into a home directory in ${withHomePath.join(", ")}. Use a path relative to the repository, or a placeholder such as \`~\` or \`<you>\`.`);
  }

  return { ok: failures.length === 0, failures, trackedCount: tracked.length, ruleCount: rules.length };
}

function main() {
  const result = checkRepoHygiene(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (result.fatal) {
    console.error(`check-hygiene: ${result.fatal}`);
    return 2;
  }
  if (!result.ok) {
    console.error(`check-hygiene: ${result.failures.length} problem(s)\n`);
    for (const failure of result.failures) console.error(`  ${failure}\n`);
    return 1;
  }
  console.log(`check-hygiene: OK. ${result.ruleCount} ignore rules, ${result.trackedCount} tracked files.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
