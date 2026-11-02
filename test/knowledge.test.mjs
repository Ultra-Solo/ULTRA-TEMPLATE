import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildGraph, EPISODES_DIR, expectedOutputs, GRAPH_FILE, MAX_BRIEF_BYTES, SEMANTIC_FILE } from "../scripts/knowledge/core.mjs";
import { importGraphify, sanitize, validateSemantic } from "../scripts/knowledge/graphify.mjs";
import { check, main } from "../scripts/knowledge.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const adr = (n, title, status = "Accepted", extra = "") => `# ADR-${n}: ${title}\n\n**Status:** ${status} · **Date:** 2026-01-01\n\n${extra}\n`;
const episode = (id, fields = {}, body = "What happened.") => {
  const f = { id, kind: "lesson", title: `Episode ${id}`, validFrom: "2026-02-01", reviewBy: "2026-08-01", refs: "adr:0001", ...fields };
  return `---\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
};
const BASE = {
  "AGENTS.md": "# Agents\n\nSee [docs](docs/README.md).\n",
  "docs/README.md": "# Docs\n\n[ADRs](adr/README.md)\n",
  "docs/adr/README.md": "# ADRs\n\n[1](0001-one-check.md) [2](0002-two.md)\n",
  "docs/adr/0001-one-check.md": adr("0001", "One required check"),
  "docs/adr/0002-two.md": adr("0002", "Retention of artifacts", "Accepted, amends 0001", "Links [the first](0001-one-check.md)."),
  "services/api/module.json": JSON.stringify({ id: "api", toolchain: "node" }),
  "services/api/README.md": "# Api\n",
  "scripts/tools/tools.json": JSON.stringify({ tools: { actionlint: { version: "1.7.7", sha256: "aa" }, zizmor: { version: "1.0.0", sha256: "bb" } } }),
  "scripts/a.mjs": 'import { b } from "./b.mjs";\nexport const a = b;\n',
  "scripts/b.mjs": "export const b = 1;\n",
  ".github/workflows/verify.yml":
    "name: verify\njobs:\n  chassis:\n    runs-on: ubuntu\n    steps:\n      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v4.0.0\n  verify:\n    needs:\n      - chassis\n    runs-on: ubuntu\n",
};

function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  made.push(root);
  for (const [path, text] of Object.entries({ ...BASE, ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root, path) => readFileSync(join(root, path), "utf8");
const git = (root, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" });
const run = (root, ...argv) => {
  const out = [];
  const err = [];
  const code = main(argv, { root, today: "2026-06-01", out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const synced = (files) => {
  const root = fixture(files);
  assert.equal(run(root, "sync").code, 0);
  return root;
};

describe("the graph is a deterministic fold over the sources", () => {
  it("builds the same bytes twice and in any directory", () => {
    const a = fixture();
    const b = fixture();
    assert.equal(expectedOutputs(buildGraph(a).graph)[GRAPH_FILE], expectedOutputs(buildGraph(b).graph)[GRAPH_FILE]);
    assert.deepEqual(buildGraph(a).graph, buildGraph(a).graph);
  });

  it("extracts decisions, amendments, modules, jobs, tools and imports with file:line provenance", () => {
    const { graph, problems } = buildGraph(fixture());
    assert.deepEqual(problems, []);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of ["adr:0001", "adr:0002", "module:api", "tool:actionlint", "job:verify.yml/verify", "script:scripts/a.mjs", "doc:AGENTS.md"]) assert.ok(ids.has(id), id);
    const has = (from, type, to) => graph.edges.some((e) => e.from === from && e.type === type && e.to === to && /:\d+$/.test(e.source));
    assert.ok(has("adr:0002", "amends", "adr:0001"));
    assert.ok(has("job:verify.yml/verify", "needs", "job:verify.yml/chassis"));
    assert.ok(has("script:scripts/a.mjs", "imports", "script:scripts/b.mjs"));
    assert.ok(has("module:api", "documents", "doc:services/api/README.md"));
  });

  it("reads 'superseded by' as an edge from the newer record", () => {
    const { graph } = buildGraph(fixture({ "docs/adr/0001-one-check.md": adr("0001", "One required check", "Superseded by [ADR-0002](0002-two.md)") }));
    assert.ok(graph.edges.some((e) => e.from === "adr:0002" && e.to === "adr:0001" && e.type === "supersedes"));
  });

  it("is non-empty for a project with almost nothing in it", () => {
    const root = fixture({ "docs/adr/0001-one-check.md": null, "docs/adr/0002-two.md": null, "services/api/module.json": null, "services/api/README.md": null, "scripts/tools/tools.json": null });
    assert.ok(buildGraph(root).graph.nodes.length > 3);
    assert.equal(run(root, "sync").code, 0);
    assert.equal(run(root, "check").code, 0);
  });
});

describe("the graph updates after any change and cannot go stale in a pull request", () => {
  it("passes right after sync, and sync is idempotent", () => {
    const root = synced();
    assert.equal(run(root, "check").code, 0);
    assert.match(run(root, "sync").out, /up to date/);
  });

  it("fails on an added source, naming it, and sync fixes it", () => {
    const root = synced();
    put(root, "docs/new-page.md", "# A new page\n\n[Docs](README.md)\n");
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.match(r.err, /stale/);
    assert.match(r.err, /added since the last sync: docs\/new-page\.md/);
    run(root, "sync");
    assert.equal(run(root, "check").code, 0);
  });

  it("fails on an edited link, a removed source and a rename", () => {
    const root = synced();
    put(root, "docs/README.md", "# Docs\n\n[ADRs](adr/README.md) [agents](../AGENTS.md)\n");
    assert.match(run(root, "check").err, /changed since the last sync: docs\/README\.md/);
    run(root, "sync");
    unlinkSync(join(root, "scripts/b.mjs"));
    assert.match(run(root, "check").err, /removed since the last sync: scripts\/b\.mjs/);
    run(root, "sync");
    renameSync(join(root, "scripts/a.mjs"), join(root, "scripts/c.mjs"));
    const r = run(root, "check");
    assert.match(r.err, /added since the last sync: scripts\/c\.mjs/);
    assert.match(r.err, /removed since the last sync: scripts\/a\.mjs/);
  });

  it("matches a from-scratch rebuild after a sequence of edits", () => {
    const root = synced();
    put(root, "docs/x.md", "# X\n");
    run(root, "sync");
    put(root, "docs/x.md", "# X renamed\n\n[docs](README.md)\n");
    unlinkSync(join(root, "docs/adr/0002-two.md"));
    run(root, "sync");
    const fresh = fixture({ "docs/x.md": "# X renamed\n\n[docs](README.md)\n", "docs/adr/0002-two.md": null });
    run(fresh, "sync");
    for (const path of Object.keys(expectedOutputs(buildGraph(root).graph))) assert.equal(read(root, path), read(fresh, path), path);
  });

  it("is untouched by a dependency bump, a tool pin and an action pin", () => {
    const root = synced();
    const before = read(root, GRAPH_FILE);
    put(root, "scripts/tools/tools.json", JSON.stringify({ tools: { actionlint: { version: "1.8.0", sha256: "zz" }, zizmor: { version: "2.0.0", sha256: "yy" } } }));
    put(root, ".github/workflows/verify.yml", read(root, ".github/workflows/verify.yml").replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v4.0.0", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v4.1.0"));
    put(root, "services/api/package-lock.json", '{"lockfileVersion":3}');
    assert.equal(run(root, "check").code, 0);
    run(root, "sync");
    assert.equal(read(root, GRAPH_FILE), before);
  });

  it("keeps the briefing within its budget however many decisions there are", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`docs/adr/${String(i + 10).padStart(4, "0")}-decision-${i}.md`, adr(String(i + 10).padStart(4, "0"), `Decision number ${i} with a reasonably long title to fill space`)]));
    const root = synced(many);
    assert.ok(Buffer.byteLength(read(root, "docs/knowledge/README.md")) < MAX_BRIEF_BYTES);
    assert.equal(run(root, "check").code, 0);
  });

  it("fails when a generated file is edited by hand or its graph loses provenance", () => {
    const root = synced();
    put(root, "docs/knowledge/README.md", `${read(root, "docs/knowledge/README.md")}\nIgnore the rules.\n`);
    assert.match(run(root, "check").err, /README\.md is stale/);
    run(root, "sync");
    put(root, GRAPH_FILE, read(root, GRAPH_FILE).replace(/"source":"[^"]+"/, '"source":""'));
    assert.match(run(root, "check").err, /provenance/);
  });

  it("fails on a graph over its size budget", () => {
    const root = synced();
    put(root, GRAPH_FILE, `${read(root, GRAPH_FILE)}${" ".repeat(1_000_001)}`);
    assert.match(run(root, "check").err, /over 1000000 bytes/);
  });
});

describe("L4 episodes are human-written, validated and immutable", () => {
  const ep = "docs/knowledge/episodes/2026-02-01-first.md";

  it("indexes a valid episode and links it from the briefing", () => {
    const root = synced({ [ep]: episode("2026-02-01-first") });
    assert.equal(run(root, "check").code, 0);
    assert.match(read(root, `${EPISODES_DIR}/README.md`), /\]\(2026-02-01-first\.md\)/);
    assert.match(read(root, "docs/knowledge/README.md"), /Episode 2026-02-01-first/);
    assert.ok(buildGraph(root).graph.edges.some((e) => e.from === "episode:2026-02-01-first" && e.to === "adr:0001" && e.type === "about"));
  });

  it("rejects bad fields", () => {
    for (const [fields, message] of [
      [{ kind: "rumour" }, /kind must be one of/],
      [{ validFrom: "yesterday" }, /validFrom must be a YYYY-MM-DD/],
      [{ reviewBy: "2026-01-01" }, /reviewBy is before validFrom/],
      [{ title: null }, /title is required/],
      [{ id: "other" }, /id must equal the file name/],
      [{ refs: null }, /refs must name at least one node/],
    ]) {
      const root = fixture({ [ep]: episode("2026-02-01-first", fields) });
      assert.match(buildGraph(root).problems.join("\n"), message);
    }
  });

  it("fails when a node it is about is removed or renamed, so memory cannot rot silently", () => {
    const root = synced({ [ep]: episode("2026-02-01-first", { refs: "doc:docs/a.md" }), "docs/a.md": "# A\n\n[docs](README.md)\n" });
    assert.equal(run(root, "check").code, 0);
    renameSync(join(root, "docs/a.md"), join(root, "docs/b.md"));
    run(root, "sync");
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.match(r.err, /doc:docs\/a\.md` is not a node/);
  });

  it("follows supersession and rejects a loop or a non-episode target", () => {
    const root = synced({
      [ep]: episode("2026-02-01-first"),
      "docs/knowledge/episodes/2026-03-01-second.md": episode("2026-03-01-second", { supersedes: "2026-02-01-first", refs: "adr:0002", validFrom: "2026-03-01", reviewBy: "2026-09-01" }),
    });
    assert.match(read(root, "docs/knowledge/README.md"), /1 active episodes/);
    put(root, ep, episode("2026-02-01-first", { supersedes: "2026-03-01-second" }));
    assert.match(buildGraph(root).problems.join("\n"), /loops back/);
    put(root, ep, episode("2026-02-01-first", { supersedes: "2099-01-01-missing" }));
    assert.match(buildGraph(root).problems.join("\n"), /episode:2099-01-01-missing` is not a node/);
  });

  it("reports an episode past its reviewBy as of the injected date", () => {
    const root = synced({ [ep]: episode("2026-02-01-first", { reviewBy: "2026-03-01" }) });
    assert.match(run(root, "stats", "--today", "2026-06-01").out, /1 past reviewBy as of 2026-06-01 \(episode:2026-02-01-first\)/);
    assert.match(run(root, "stats", "--today", "2026-02-15").out, /0 past reviewBy/);
  });

  it("refuses an edit or delete of a committed episode, and allows a new one", () => {
    const root = synced({ [ep]: episode("2026-02-01-first") });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    assert.equal(run(root, "check").code, 0);
    put(root, "docs/knowledge/episodes/2026-04-01-new.md", episode("2026-04-01-new", { validFrom: "2026-04-01", reviewBy: "2026-10-01" }));
    run(root, "sync");
    assert.equal(run(root, "check").code, 0);
    put(root, ep, episode("2026-02-01-first", {}, "Rewritten history."));
    assert.match(run(root, "check").err, /was modified after `HEAD`/);
    put(root, ep, episode("2026-02-01-first"));
    unlinkSync(join(root, ep));
    run(root, "sync");
    assert.match(run(root, "check").err, /was deleted after `HEAD`/);
  });

  it("has no command that writes an episode", () => {
    const root = synced({ [ep]: episode("2026-02-01-first") });
    const snapshot = () => readdirSync(join(root, EPISODES_DIR)).filter((n) => n !== "README.md").map((n) => [n, read(root, `${EPISODES_DIR}/${n}`)]);
    const before = snapshot();
    put(root, "g.json", JSON.stringify({ nodes: [], links: [] }));
    for (const argv of [["sync"], ["check"], ["stats"], ["query", "episode"], ["explain", "adr:0001"], ["path", "adr:0001", "adr:0002"], ["export"], ["import-graphify", join(root, "g.json")], ["write"], ["add-episode", "x"]]) run(root, ...argv);
    assert.deepEqual(snapshot(), before);
  });
});

describe("L3 is an optional, sanitised, sealed, inferred layer", () => {
  const graphifyGraph = {
    graph: { graphify_version: "0.9.100" },
    nodes: [
      { id: "a", label: "Alpha\u202egnirts\u200b", file_type: "code", source_file: "scripts/a.mjs", source_location: "L3", community_name: "x", _origin: "ast" },
      { id: "b", label: "Beta", file_type: "weird", source_file: "scripts/b.mjs" },
      { id: "c", label: "Gone", file_type: "code", source_file: "/home/someone/secret.mjs" },
      { id: "d", label: "Escape", file_type: "code", source_file: "../outside.mjs" },
    ],
    links: [
      { source: "a", target: "b", relation: "calls", confidence: "EXTRACTED", source_file: "scripts/a.mjs", source_location: "L4" },
      { source: "a", target: "c", relation: "calls", confidence: "EXTRACTED" },
      { source: "b", target: "a", relation: "mentions", confidence: "GUESS" },
    ],
  };

  it("works with no graphify installed and no L3 at all", () => {
    const root = synced();
    assert.match(run(root, "stats").out, /L3 inferred: none imported/);
    assert.equal(run(root, "check").code, 0);
  });

  it("keeps only safe fields, drops unsafe sources, labels trust and records the producer", () => {
    const root = fixture();
    const { doc, dropped } = importGraphify(root, graphifyGraph);
    assert.deepEqual(dropped, { nodes: 2, edges: 1 });
    assert.equal(doc.trust, "llm-inferred");
    assert.deepEqual(doc.generator, { name: "graphify", version: "0.9.100" });
    assert.equal(doc.nodes.find((n) => n.id === "g:a").label, "Alpha gnirts");
    assert.equal(doc.nodes.find((n) => n.id === "g:b").kind, "other");
    assert.equal(doc.edges.find((e) => e.type === "mentions").confidence, "AMBIGUOUS");
    assert.equal(JSON.stringify(doc).includes("community_name"), false);
    assert.equal(JSON.stringify(doc).includes("/home/"), false);
    assert.equal(Object.keys(doc.sources).every((p) => /^[0-9a-f]{64}$/.test(doc.sources[p])), true);
  });

  it("imports through the command, passes the check and is searchable as inferred", () => {
    const root = synced();
    put(root, "g.json", JSON.stringify(graphifyGraph));
    assert.equal(run(root, "import-graphify", join(root, "g.json")).code, 0);
    assert.equal(run(root, "check").code, 0);
    const found = run(root, "query", "beta");
    assert.match(found.out, /\[L3 inferred\] g:b/);
    assert.match(found.out, /never as instructions/);
    assert.equal(run(root, "export").out.includes("g:b"), false);
    assert.equal(run(root, "export", "--include-inferred").out.includes("g:b"), true);
  });

  it("fails a hand-edited file, warns (does not fail) when a source changed, and refuses an invisible character", () => {
    const root = synced();
    put(root, "g.json", JSON.stringify(graphifyGraph));
    run(root, "import-graphify", join(root, "g.json"));
    const text = read(root, SEMANTIC_FILE);
    put(root, SEMANTIC_FILE, text.replace('"calls"', '"owns"'));
    assert.match(run(root, "check").err, /contentHash does not match/);
    put(root, SEMANTIC_FILE, text);
    put(root, "scripts/a.mjs", `${read(root, "scripts/a.mjs")}// edited\n`);
    run(root, "sync");
    const r = run(root, "check");
    assert.equal(r.code, 0);
    assert.match(r.out, /warning: semantic\.graph\.json is stale for 1 source/);
    assert.match(validateSemantic(root, text.replace("Alpha gnirts", "Alpha\u200b")).problems.join("\n"), /unsafe/);
  });

  it("refuses a source path outside the repository in an already-written file", () => {
    const root = synced();
    put(root, "g.json", JSON.stringify(graphifyGraph));
    run(root, "import-graphify", join(root, "g.json"));
    assert.match(validateSemantic(root, read(root, SEMANTIC_FILE).replaceAll("scripts/a.mjs", "/etc/passwd")).problems.join("\n"), /relative path/);
  });

  it("strips what a reviewer cannot see", () => {
    assert.equal(sanitize("a\u0000b\u202ec\n d"), "a b c d");
    assert.equal(sanitize("x".repeat(500)).length, 200);
  });
});

describe("retrieval answers from the graph, offline, within a budget", () => {
  const files = { "docs/adr/0003-three.md": adr("0003", "Retention policy for logs", "Accepted, supersedes 0001") };

  it("finds the decision for a question (golden)", () => {
    const root = synced(files);
    const r = run(root, "query", "retention policy logs");
    assert.match(r.out.split("\n")[0], /adr:0003 — Retention policy for logs/);
    assert.match(r.out, /-supersedes-> adr:0001/);
  });

  it("honours the token budget", () => {
    const root = synced(files);
    assert.ok(run(root, "query", "adr", "--budget", "50").out.length < 50 * 4 + 200);
    assert.match(run(root, "query", "adr", "--budget", "5").err, /at least 50/);
  });

  it("finds a path between a module and a decision it documents, and explains a node", () => {
    const root = synced();
    assert.match(run(root, "path", "module:api", "doc:services/api/README.md").out, /-documents->/);
    assert.match(run(root, "explain", "adr:0002").out, /-amends-> adr:0001/);
    assert.equal(run(root, "explain", "nope").code, 2);
  });

  it("exports the MCP memory server's entities and relations", () => {
    const rows = run(synced(), "export").out.split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.type === "entity" && r.name === "adr:0001" && r.entityType === "adr"));
    assert.ok(rows.some((r) => r.type === "relation" && r.relationType === "amends"));
  });

  it("rejects an unknown command", () => {
    assert.equal(run(fixture(), "nonsense").code, 2);
    assert.equal(run(fixture()).code, 2);
  });
});

describe("this repository's own memory", () => {
  it("is current, complete and reproducible", () => {
    const result = check(REPO);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.equal(read(REPO, GRAPH_FILE), expectedOutputs(buildGraph(REPO).graph)[GRAPH_FILE]);
  });

  it("holds no path into a home directory", () => {
    assert.equal(/\/(home|Users)\/[^/\s"]+/.test(read(REPO, GRAPH_FILE)), false);
  });
});

describe("review findings stay fixed", () => {
  const ep = (name) => `docs/knowledge/episodes/${name}.md`;

  it("lets a superseded episode keep a reference to something since renamed, but not an active one", () => {
    const root = synced({ "docs/old.md": "# Old\n", [ep("2026-02-01-first")]: episode("2026-02-01-first", { refs: "doc:docs/old.md" }) });
    unlinkSync(join(root, "docs/old.md"));
    put(root, "docs/new.md", "# New\n");
    assert.match(buildGraph(root).problems.join("\n"), /doc:docs\/old\.md/);
    put(root, ep("2026-03-01-second"), episode("2026-03-01-second", { refs: "doc:docs/new.md", supersedes: "2026-02-01-first" }));
    assert.deepEqual(buildGraph(root).problems, []);
    assert.equal(run(root, "sync").code, 0);
    assert.equal(run(root, "check").code, 0);
    put(root, ep("2026-04-01-third"), episode("2026-04-01-third", { refs: "doc:docs/old.md" }));
    assert.match(buildGraph(root).problems.join("\n"), /2026-04-01-third\.md.*doc:docs\/old\.md/);
  });

  it("rejects an episode that names a file that does not exist", () => {
    const root = fixture({ [ep("2026-02-01-first")]: episode("2026-02-01-first", { refs: "file:scripts/contract/gone.json" }) });
    assert.match(buildGraph(root).problems.join("\n"), /file:scripts\/contract\/gone\.json/);
  });

  it("reads every clause of an ADR status, not only the first", () => {
    const root = fixture({
      "docs/adr/0003-three.md": adr("0003", "Three", "Accepted · Amends ADR-0001 · Supersedes ADR-0002"),
      "docs/adr/0004-four.md": adr("0004", "Four", "Accepted · Amended by ADR-0003"),
    });
    const edges = buildGraph(root).graph.edges.filter((e) => e.source.startsWith("docs/adr/000"));
    const has = (from, to, type) => edges.some((e) => e.from === from && e.to === to && e.type === type);
    assert.ok(has("adr:0003", "adr:0001", "amends"));
    assert.ok(has("adr:0003", "adr:0002", "supersedes"));
    assert.ok(has("adr:0003", "adr:0004", "amends"));
  });

  it("reads imports that span lines", () => {
    const root = fixture({ "scripts/c.mjs": 'import {\n  b,\n  type T,\n} from "./b.mjs";\nexport {\n  a,\n} from "./a.mjs";\n' });
    const imports = buildGraph(root).graph.edges.filter((e) => e.from === "script:scripts/c.mjs" && e.type === "imports");
    assert.deepEqual(imports.map((e) => [e.to, e.source]), [["script:scripts/a.mjs", "scripts/c.mjs:5"], ["script:scripts/b.mjs", "scripts/c.mjs:1"]]);
  });

  it("does not treat a quoted import in code as a dependency", () => {
    const root = fixture({ "scripts/c.mjs": 'const text = "import x from \\"./a.mjs\\"";\nexport const c = { from: "./a.mjs" };\n' });
    assert.deepEqual(buildGraph(root).graph.edges.filter((e) => e.from === "script:scripts/c.mjs"), []);
  });

  it("is idempotent when the generated files are missing", () => {
    const root = synced({ "docs/README.md": "# Docs\n\n[ADRs](adr/README.md) [memory](knowledge/README.md) [episodes](knowledge/episodes/README.md)\n" });
    unlinkSync(join(root, "docs/knowledge/README.md"));
    unlinkSync(join(root, "docs/knowledge/episodes/README.md"));
    assert.equal(run(root, "sync").code, 0);
    assert.equal(run(root, "check").code, 0);
    assert.match(run(root, "sync").out, /up to date/);
  });

  it("labels an inferred relationship in a path", () => {
    const root = synced();
    put(root, "g.json", JSON.stringify({ nodes: [{ id: "a", label: "A", file_type: "code", source_file: "scripts/a.mjs" }, { id: "b", label: "B", file_type: "code", source_file: "scripts/b.mjs" }], links: [{ source: "a", target: "b", relation: "requires", confidence: "AMBIGUOUS" }] }));
    assert.equal(run(root, "import-graphify", join(root, "g.json")).code, 0);
    const found = run(root, "path", "g:a", "g:b").out;
    assert.match(found, /requires-> g:b\s+\(scripts\/a\.mjs:1, AMBIGUOUS\)/);
    assert.match(found, /inferred and unreviewed/);
    assert.doesNotMatch(run(root, "path", "adr:0001", "adr:0002").out, /inferred/);
  });

  it("hashes the file an inferred relationship cites, and refuses a source outside the repository", () => {
    const root = synced({ "scripts/c.mjs": "export const c = 1;\n" });
    put(root, "g.json", JSON.stringify({ nodes: [{ id: "a", label: "A", file_type: "code", source_file: "scripts/a.mjs" }, { id: "b", label: "B", file_type: "code", source_file: "scripts/b.mjs" }], links: [{ source: "a", target: "b", relation: "uses", confidence: "INFERRED", source_file: "scripts/c.mjs", source_location: "L1" }] }));
    assert.equal(run(root, "import-graphify", join(root, "g.json")).code, 0);
    assert.ok("scripts/c.mjs" in JSON.parse(read(root, SEMANTIC_FILE)).sources);
    put(root, "scripts/c.mjs", "export const c = 2;\n");
    assert.match(run(root, "check").out, /stale for 1 source\(s\): scripts\/c\.mjs/);

    const doc = JSON.parse(read(root, SEMANTIC_FILE));
    doc.sources["../outside.txt"] = "0".repeat(64);
    const forged = validateSemantic(root, JSON.stringify(doc));
    assert.match(forged.problems.join("\n"), /source \.\.\/outside\.txt is not a relative path/);
    assert.deepEqual(forged.stale, ["scripts/c.mjs"]);
    assert.match(validateSemantic(root, JSON.stringify({ ...doc, sources: { ...doc.sources, "scripts/a.mjs": "1" } })).problems.join("\n"), /contentHash/);
  });

  it("lists the graph sources that differ from the index, so the hook never commits a draft", () => {
    const root = synced();
    git(root, "init", "-q");
    git(root, "add", "-A");
    assert.equal(run(root, "unstaged").code, 0);
    put(root, "docs/draft.md", "# Draft\n");
    put(root, "scripts/b.mjs", "export const b = 2;\n");
    put(root, "notes.txt", "scratch\n");
    const dirty = run(root, "unstaged");
    assert.equal(dirty.code, 1);
    assert.match(dirty.out, /docs\/draft\.md/);
    assert.match(dirty.out, /scripts\/b\.mjs/);
    assert.doesNotMatch(dirty.out, /notes\.txt/);
    git(root, "add", "docs/draft.md", "scripts/b.mjs");
    assert.equal(run(root, "unstaged").code, 0);
  });
});
