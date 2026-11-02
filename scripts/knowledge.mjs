#!/usr/bin/env node
/**
 * The memory engine's command line. It reads and writes only under docs/knowledge/, depends on
 * nothing but Node, and never writes an episode: those are written by people.
 *
 *   node scripts/knowledge.mjs sync                      rebuild L0 and L2 from the files; idempotent
 *   node scripts/knowledge.mjs check [--base REF]        fail when anything is stale or inconsistent
 *   node scripts/knowledge.mjs query "<words>" [--budget N]
 *   node scripts/knowledge.mjs path <from> <to>
 *   node scripts/knowledge.mjs explain <node>
 *   node scripts/knowledge.mjs stats [--today YYYY-MM-DD]
 *   node scripts/knowledge.mjs import-graphify <graph.json>   L3, from graphify's node-link output
 *   node scripts/knowledge.mjs export [--include-inferred]    MCP memory server JSONL on stdout
 *
 * Exit 0 clean · 1 a check failed · 2 usage or the repository cannot be read.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  BRIEF_FILE,
  buildGraph,
  EPISODES_DIR,
  EPISODES_INDEX,
  expectedOutputs,
  GRAPH_FILE,
  graphIntegrity,
  listFiles,
  MAX_BRIEF_BYTES,
  MAX_GRAPH_BYTES,
  SEMANTIC_FILE,
  sourceDrift,
  sourceKind,
} from "./knowledge/core.mjs";
import { importGraphify, validateSemantic } from "./knowledge/graphify.mjs";
import { DEFAULT_BUDGET, exportMemoryJsonl, explain, mergeLayers, query, shortestPath, stats } from "./knowledge/query.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readOptional = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);

/** Writes the generated files that differ from what the sources say. Never touches an episode. */
export function sync(root) {
  const { graph, problems } = buildGraph(root);
  const written = [];
  for (const [path, text] of Object.entries(expectedOutputs(graph))) {
    if (readOptional(root, path) === text) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    written.push(path);
  }
  return { graph, problems, written };
}

/** Episodes are immutable: against a base, none may be modified, renamed or deleted. */
function episodeEdits(root, base) {
  let out;
  try {
    out = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "--", EPISODES_DIR], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { skipped: `episodes were not compared with \`${base}\` (no such revision, or not a git repository)`, problems: [] };
  }
  const problems = out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([status, path]) => path !== EPISODES_INDEX && status !== "A")
    .map(([status, path]) => `${path} was ${status === "D" ? "deleted" : "modified"} after \`${base}\`. An episode is never edited in place: write a new one that supersedes it`);
  return { skipped: null, problems };
}

/** Everything `verify` needs to know: failures, warnings, and notes that are neither. */
export function check(root, { base = "HEAD" } = {}) {
  const { graph, problems: built } = buildGraph(root);
  const problems = [...built];
  const warnings = [];
  const notes = [];
  const expected = expectedOutputs(graph);
  let onDisk = null;
  for (const [path, text] of Object.entries(expected)) {
    const actual = readOptional(root, path);
    if (actual === null) problems.push(`${path} is missing. Run \`node scripts/knowledge.mjs sync\``);
    else if (actual !== text) problems.push(`${path} is stale. Run \`node scripts/knowledge.mjs sync\` and commit the result`);
  }
  const diskText = readOptional(root, GRAPH_FILE);
  if (diskText !== null) {
    if (Buffer.byteLength(diskText) > MAX_GRAPH_BYTES) problems.push(`${GRAPH_FILE} is over ${MAX_GRAPH_BYTES} bytes`);
    try {
      onDisk = JSON.parse(diskText);
      problems.push(...graphIntegrity(onDisk));
      const drift = sourceDrift(onDisk, graph);
      for (const [label, list] of [["added", drift.added], ["removed", drift.removed], ["changed", drift.changed]]) {
        if (list.length > 0) problems.push(`sources ${label} since the last sync: ${list.slice(0, 6).join(", ")}${list.length > 6 ? ", …" : ""}`);
      }
      const covered = new Set(onDisk.nodes.map((n) => n.path));
      for (const path of listFiles(root)) {
        const kind = sourceKind(path);
        if (kind !== null && kind !== "tools" && !covered.has(path)) problems.push(`${path} is not a node in ${GRAPH_FILE}, so memory cannot see it`);
      }
    } catch {
      problems.push(`${GRAPH_FILE} is not valid JSON`);
    }
  }
  if (Buffer.byteLength(expected[BRIEF_FILE]) > MAX_BRIEF_BYTES) problems.push(`${BRIEF_FILE} would be over ${MAX_BRIEF_BYTES} bytes: the briefing must stay small enough to load first`);
  const semanticText = readOptional(root, SEMANTIC_FILE);
  if (semanticText !== null) {
    const verdict = validateSemantic(root, semanticText);
    problems.push(...verdict.problems);
    warnings.push(...verdict.warnings);
  }
  const edits = episodeEdits(root, base);
  problems.push(...edits.problems);
  if (edits.skipped) notes.push(edits.skipped);
  return { ok: problems.length === 0, problems: [...new Set(problems)], warnings, notes, graph };
}

function loadLayers(root) {
  const { graph } = buildGraph(root);
  const text = readOptional(root, SEMANTIC_FILE);
  const verdict = text === null ? null : validateSemantic(root, text);
  if (verdict && verdict.problems.length > 0) throw new Error(`${SEMANTIC_FILE} is invalid (${verdict.problems[0]}). Run \`check\``);
  return { graph, semantic: verdict?.doc ?? null, stale: verdict?.stale ?? [] };
}

export function main(argv, { root = ROOT, today = new Date().toISOString().slice(0, 10), env = process.env, out = console.log, err = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { base: { type: "string" }, budget: { type: "string" }, today: { type: "string" }, "include-inferred": { type: "boolean" } },
    });
  } catch (e) {
    err(e.message);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const flags = parsed.values;
  try {
    if (command === "sync") {
      const { problems, written } = sync(root);
      out(written.length === 0 ? "knowledge: up to date" : `knowledge: wrote ${written.join(", ")}`);
      for (const p of problems) err(`✗ ${p}`);
      return problems.length === 0 ? 0 : 1;
    }
    if (command === "check") {
      const result = check(root, { base: flags.base ?? env.KNOWLEDGE_BASE_REF ?? "HEAD" });
      for (const n of result.notes) out(`note: ${n}`);
      for (const w of result.warnings) out(`warning: ${w}`);
      for (const p of result.problems) err(`✗ ${p}`);
      out(result.ok ? `knowledge: ok (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)` : `knowledge: ${result.problems.length} problem(s)`);
      return result.ok ? 0 : 1;
    }
    if (command === "query") {
      const budget = flags.budget === undefined ? DEFAULT_BUDGET : Number(flags.budget);
      if (!Number.isInteger(budget) || budget < 50) throw new Error("--budget must be a whole number of at least 50");
      const { graph, semantic } = loadLayers(root);
      out(query(mergeLayers(graph, semantic), rest.join(" "), { budget }).trimEnd());
      return 0;
    }
    if (command === "path" || command === "explain") {
      const { graph, semantic } = loadLayers(root);
      const memory = mergeLayers(graph, semantic);
      if (command === "path") {
        if (rest.length !== 2) throw new Error("usage: path <from> <to>");
        out(shortestPath(memory, rest[0], rest[1]).trimEnd());
      } else {
        if (rest.length !== 1) throw new Error("usage: explain <node>");
        out(explain(memory, rest[0]).trimEnd());
      }
      return 0;
    }
    if (command === "stats") {
      const { graph, semantic, stale } = loadLayers(root);
      const drift = sourceDrift(readOptional(root, GRAPH_FILE) === null ? null : JSON.parse(readOptional(root, GRAPH_FILE)), graph);
      out(stats({ graph, semantic, drift, semanticStale: stale, today: flags.today ?? today }).text.trimEnd());
      return 0;
    }
    if (command === "import-graphify") {
      if (rest.length !== 1) throw new Error("usage: import-graphify <graph.json>");
      const { doc, dropped, text } = importGraphify(root, JSON.parse(readFileSync(resolve(rest[0]), "utf8")));
      const verdict = validateSemantic(root, text);
      if (verdict.problems.length > 0) throw new Error(`refusing to write: ${verdict.problems[0]}`);
      writeFileSync(join(root, SEMANTIC_FILE), text);
      out(`knowledge: wrote ${SEMANTIC_FILE} (${doc.nodes.length} nodes, ${doc.edges.length} edges; dropped ${dropped.nodes} nodes and ${dropped.edges} edges with no safe source)`);
      return 0;
    }
    if (command === "export") {
      const { graph, semantic } = loadLayers(root);
      out(exportMemoryJsonl(graph, semantic, { includeInferred: flags["include-inferred"] === true }).trimEnd());
      return 0;
    }
  } catch (e) {
    err(`knowledge: ${e.message}`);
    return 2;
  }
  err('usage: node scripts/knowledge.mjs <sync|check|query "<words>"|path <a> <b>|explain <node>|stats|import-graphify <file>|export>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
