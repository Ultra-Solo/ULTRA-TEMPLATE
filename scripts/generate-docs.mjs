/**
 * The parts of the documentation that restate a fact, written from the file that states it.
 *
 * A README that says "PORT defaults to 8080" is a second statement of the contract, and it goes stale
 * the day the contract changes. So each such part is a generated block, between a comment that names its
 * source and a closing comment, and this writes its content from that source. check-docs fails when a
 * block is stale and says to run this.
 *
 *   <!-- generated:contract config.PORT.default.value -->8080<!-- /generated -->     inline
 *   <!-- generated:config-table -->                                                a block of its own
 *   …
 *   <!-- /generated -->
 *
 * A `fill` block keeps a template in its opening comment, and its content is that template with each
 * {{kind args}} filled in by an inline kind. It is how a code example states a value: Markdown shows a
 * comment inside a fence as text, but hides a fence inside a comment.
 *
 *   node scripts/generate-docs.mjs            # rewrite every stale block
 *   node scripts/generate-docs.mjs --check    # list stale blocks, change nothing
 *
 * Each kind reads one file, and never which modules are present, so a block and its source leave a
 * project together and init never leaves a block behind that its project cannot regenerate.
 * Exit 0 up to date (or rewritten) · 1 --check found a stale block · 2 a block names what does not exist.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { leadingVersion, specifierFloor, TOOLCHAIN_VERSIONS, tomlString } from "./check-hygiene.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = "scripts/contract/tasks-api.json";
const OPENAPI = "scripts/contract/openapi.json";
const RULES = "scripts/rules/task-rules.json";
const TOOLS = "scripts/tools/tools.json";
const FEATURES = "template/features.json";

export class DocsError extends Error {}

/** A generated block: its kind, its arguments (a fill's template), and its content. */
const BLOCK = /<!-- generated:([a-z-]+)([\s\S]*?)-->([\s\S]*?)<!-- \/generated -->/g;
const CLOSE = "<!-- /generated -->";
const PLACEHOLDER = /\{\{([a-z-]+)((?: [^\s}]+)*)\}\}/g;

const at = (value, path, source) => {
  const found = path.split(".").reduce((node, key) => (node !== null && typeof node === "object" ? node[key] : undefined), value);
  if (found === undefined) throw new DocsError(`${source} has nothing at ${path}`);
  return found;
};

/** 1048576 → "1 MiB": a size as a reader thinks of it, exact or not at all. */
export function bytes(n) {
  for (const [unit, size] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ])
    if (n % size === 0) return `${n / size} ${unit}`;
  return `${n} bytes`;
}

// The keys of an OpenAPI path item that are operations; the rest, such as `parameters`, describe them.
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");

// Where each manifest's tool is needed, and where its checksum comes from, as the pin table says it.
const NEEDED = {
  chassis: "everywhere",
  go: "with a Go module",
  node: "with a Node module",
  python: "with a Python module",
  ci: "in CI only",
};

/** The kinds of block, each a function of its arguments and a reader of the repository's files. */
export const GENERATORS = {
  /** The version a toolchain file declares, as precisely as it matters: Node's major, Go's and Python's minor. */
  version: ([file], read) => {
    const [, toolchain] = Object.entries(TOOLCHAIN_VERSIONS).find(([, t]) => t.file.test(file)) ?? [];
    if (!toolchain) throw new DocsError(`${file} is not a file that declares a toolchain version`);
    return leadingVersion(toolchain.read(read(file)), toolchain.parts);
  },
  /** The oldest Python a pyproject.toml's requires-python admits. */
  floor: ([file], read) => leadingVersion(specifierFloor(tomlString(read(file), "project", "requires-python") ?? ""), 2),
  /** One value of the task API contract, raw or as `bytes`. */
  contract: ([path, format], read) => {
    const value = at(JSON.parse(read(CONTRACT)), path, CONTRACT);
    return format === "bytes" ? bytes(value) : String(value);
  },
  /** One of the task rules. */
  rules: ([path], read) => String(at(JSON.parse(read(RULES)), path, RULES)),
  /** The version the manifest pins a tool at. */
  tool: ([name], read) => at(JSON.parse(read(TOOLS)).tools, `${name}.version`, TOOLS),
  /** Every variable a task service reads: its default and what it is for. */
  "config-table": (_, read) =>
    table(
      ["Variable", "Default", "Meaning"],
      Object.entries(JSON.parse(read(CONTRACT)).config)
        .filter(([name]) => !name.startsWith("$"))
        .map(([name, spec]) => [`\`${name}\``, `\`${spec.default.value}\``, spec.meaning]),
    ),
  /** Every operation of the task API, the fields it takes and what it answers. */
  "api-table": (_, read) => {
    const spec = JSON.parse(read(OPENAPI));
    const deref = (node) =>
      node?.$ref
        ? node.$ref
            .slice(2)
            .split("/")
            .reduce((n, key) => n?.[key], spec)
        : node;
    const rows = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([method]) => HTTP_METHODS.includes(method))
        .map(([method, operation]) => {
          const body = deref(deref(operation.requestBody)?.content?.["application/json"]?.schema);
          const fields = body?.properties
            ? ` \`{${Object.keys(body.properties)
                .map((f) => `"${f}"`)
                .join(", ")}}\``
            : "";
          const answers = Object.entries(operation.responses).map(([code, response]) => `\`${code}\` ${deref(response).description}`);
          return [`\`${method.toUpperCase()} ${path}\`${fields}`, answers.join(" · ")];
        }),
    );
    return table(["Method and path", "Answers"], rows);
  },
  /** Every tool pinned by hand: its version, where it is needed, and where its checksum is taken from. */
  "tools-table": (_, read) =>
    table(
      ["Tool", "Version", "Needed", "Checksum"],
      Object.entries(JSON.parse(read(TOOLS)).tools).map(([name, tool]) => {
        const source = Object.values(tool.releases)[0];
        const home = tool.releases.github ?? tool.releases.githubTags;
        const checksum = tool.run
          ? `none: run as \`${tool.run.join(" ").replaceAll("{version}", tool.version)}\``
          : tool.checksums.file
            ? "the release's checksum file"
            : tool.checksums.sidecar
              ? `the \`${tool.checksums.sidecar}\` file beside each asset`
              : "the digest GitHub records for each asset";
        return [
          home ? `[${name}](https://github.com/${home}/${tool.releases.githubTags ? "tags" : "releases"})` : `[${name}](https://pypi.org/project/${source}/)`,
          tool.version,
          NEEDED[tool.for] ?? tool.for,
          checksum,
        ];
      }),
    ),
  /** The template's presets and the features each selects. */
  "presets-table": (_, read) => {
    const { features, presets } = JSON.parse(read(FEATURES));
    const every = Object.keys(features);
    return table(
      ["Preset", "Features"],
      Object.entries(presets).map(([name, ids]) => [
        `\`${name}\``,
        ids.length === 0 ? "none: the chassis only" : ids.length === every.length && every.every((id) => ids.includes(id)) ? "every feature" : ids.map((id) => `\`${id}\``).join(", "),
      ]),
    );
  },
  /** The template's features and what each gives a project. */
  "features-table": (_, read) =>
    table(
      ["Feature", "What you get"],
      Object.entries(JSON.parse(read(FEATURES)).features).map(([id, feature]) => [`\`${id}\``, feature.summary]),
    ),
  /**
   * A module's checks as its module.json declares them, which verify and its CI job run. An `npm run`
   * check names the steps of that script, so the list cannot leave one out.
   */
  checks: ([dir], read) => {
    const module = JSON.parse(read(`${dir}/module.json`));
    const lines = module.checks.map(({ run }) => {
      const [command, verb, script] = run;
      if (command !== "npm" || verb !== "run" || run.length !== 3) return run.join(" ");
      const body = JSON.parse(read(`${dir}/package.json`)).scripts?.[script];
      if (body === undefined) throw new DocsError(`${dir}/package.json has no script called ${script}`);
      const steps = body.split("&&").map((part) => part.trim().replace(/^npm (run )?/, ""));
      return `${run.join(" ")}   # ${steps.join(", ")}`;
    });
    return ["```bash", ...lines, "```"].join("\n");
  },
  /** The environment variables an MCP server.json advertises. */
  "env-table": ([file], read) =>
    table(
      ["Variable", "Default", "Meaning"],
      JSON.parse(read(file))
        .packages.flatMap((pkg) => pkg.environmentVariables ?? [])
        .map((v) => [`\`${v.name}\``, v.default === undefined ? "none" : `\`${v.default}\``, v.description]),
    ),
};

/**
 * `text` with every generated block rewritten, and the blocks that were stale. A block's content is its
 * generator's output, on lines of its own when the block spans lines, inline otherwise.
 */
export function regenerate(text, read, where = "<text>") {
  const stale = [];
  const out = text.replace(BLOCK, (whole, kind, rawArgs, content) => {
    const run = (name, args) => {
      const generator = GENERATORS[name];
      if (!generator)
        throw new DocsError(`${where}: no generated block is called "${name}"; known: fill, ${Object.keys(GENERATORS).join(", ")}`);
      try {
        return generator(args, read);
      } catch (err) {
        throw new DocsError(`${where}: generated:${name} ${args.join(" ")}: ${err.message}`);
      }
    };
    const split = (text) => (text.trim() === "" ? [] : text.trim().split(/\s+/));
    const value =
      kind === "fill"
        ? rawArgs
            .replace(/^[ \t]*\n/, "")
            .replace(/\n[ \t]*$/, "")
            .replace(PLACEHOLDER, (_, name, args) => run(name, split(args)))
        : run(kind, split(rawArgs));
    const fresh = content.startsWith("\n") ? `\n${value}\n` : value;
    if (fresh !== content) stale.push(kind === "fill" ? "fill" : `${kind} ${split(rawArgs).join(" ")}`.trim());
    return whole.slice(0, whole.length - content.length - CLOSE.length) + fresh + CLOSE;
  });
  return { text: out, stale };
}

function main(argv) {
  const check = argv.includes("--check");
  const read = (path) => {
    if (!existsSync(join(ROOT, path))) throw new DocsError(`${path} does not exist here`);
    return readFileSync(join(ROOT, path), "utf8");
  };
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  let staleCount = 0;
  for (const file of files.filter((f) => existsSync(join(ROOT, f)))) {
    const before = read(file);
    if (!before.includes("<!-- generated:")) continue;
    const { text, stale } = regenerate(before, read, file);
    if (stale.length === 0) continue;
    staleCount += stale.length;
    if (check) console.error(`generate-docs: ${file} has stale block(s): ${stale.join(", ")}`);
    else {
      writeFileSync(join(ROOT, file), text);
      console.log(`generate-docs: rewrote ${stale.length} block(s) in ${file}`);
    }
  }
  if (check && staleCount > 0) {
    console.error("generate-docs: run node scripts/generate-docs.mjs to rewrite them from their sources.");
    return 1;
  }
  if (staleCount === 0) console.log("generate-docs: every generated block is up to date.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`generate-docs: ${err instanceof DocsError ? err.message : err.stack}`);
    process.exitCode = 2;
  }
}
