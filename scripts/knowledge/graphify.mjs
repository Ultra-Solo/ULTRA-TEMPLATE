/**
 * L3: the inferred layer. A maintainer imports another tool's graph (graphify is the first adapter);
 * the engine itself never depends on any such tool. Whatever a producer wrote is untrusted text: it
 * is reduced to a fixed set of fields, stripped of anything a reviewer cannot see, bound to the
 * sources it describes by SHA-256, labelled as inferred, and sealed with a hash so a hand edit shows.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { compare, SCHEMA_VERSION, sha256 } from "./core.mjs";

export const MAX_SEMANTIC_BYTES = 1_500_000;
export const TRUST = "llm-inferred";
const CONFIDENCE = new Set(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
const FILE_TYPES = new Set(["code", "document", "paper", "image", "video"]);
// Control, zero-width, bidirectional and other invisible format characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** A producer's string made safe to store and to print: visible characters only, one line, bounded. */
export function sanitize(value, max = 200) {
  return String(value ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const relativePath = (value) => {
  const path = sanitize(value, 300).replaceAll("\\", "/");
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const clean = posix.normalize(path);
  return clean.startsWith("..") ? null : clean;
};

/** The content hash that seals nodes and edges. */
const seal = (nodes, edges) => sha256(JSON.stringify({ nodes, edges }));

/**
 * graphify's `graph.json` (node-link: `nodes` and `links`) reduced to the engine's L3 schema. Only
 * `id`, `label`, `file_type`, `source_file`, `source_location` and each link's `relation`,
 * `confidence`, `source_file`, `source_location` are read; every other field is dropped.
 */
export function importGraphify(root, input) {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.links ?? input.edges)) {
    throw new Error("not a graphify graph.json: expected `nodes` and `links` arrays");
  }
  const dropped = { nodes: 0, edges: 0 };
  const nodes = [];
  const ids = new Set();
  for (const raw of input.nodes) {
    const id = sanitize(raw?.id, 200);
    const sourceFile = relativePath(raw?.source_file);
    if (id === "" || sourceFile === null || !existsSync(join(root, sourceFile))) {
      dropped.nodes += 1;
      continue;
    }
    if (ids.has(`g:${id}`)) continue;
    ids.add(`g:${id}`);
    nodes.push({
      id: `g:${id}`,
      kind: FILE_TYPES.has(raw.file_type) ? raw.file_type : "other",
      label: sanitize(raw.label) || id,
      path: sourceFile,
      layer: "L3",
      ...(raw.source_location ? { location: sanitize(raw.source_location, 40) } : {}),
    });
  }
  nodes.sort((a, b) => compare(a.id, b.id));
  const edges = [];
  const seen = new Set();
  for (const raw of input.links ?? input.edges) {
    const from = `g:${sanitize(raw?.source, 200)}`;
    const to = `g:${sanitize(raw?.target, 200)}`;
    const type = sanitize(raw?.relation, 60) || "related";
    if (!ids.has(from) || !ids.has(to)) {
      dropped.edges += 1;
      continue;
    }
    const key = `${from}\0${to}\0${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceFile = relativePath(raw.source_file);
    const line = /^L?(\d+)/.exec(String(raw.source_location ?? ""));
    edges.push({
      from,
      to,
      type,
      confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : "AMBIGUOUS",
      source: sourceFile && line ? `${sourceFile}:${line[1]}` : (nodes.find((n) => n.id === from)?.path ?? "unknown") + ":1",
    });
  }
  edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type));
  const sources = {};
  for (const path of [...new Set(nodes.map((n) => n.path))].sort(compare)) sources[path] = sha256(readFileSync(join(root, path)));
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    layer: "L3",
    trust: TRUST,
    generator: { name: "graphify", version: sanitize(input.graph?.graphify_version, 40) || "unknown" },
    sources,
    contentHash: seal(nodes, edges),
    nodes,
    edges,
  };
  return { doc, dropped, text: serializeSemantic(doc) };
}

export function serializeSemantic(doc) {
  const each = (items) => items.map((i) => JSON.stringify(i)).join(",\n");
  const head = ["schemaVersion", "layer", "trust", "generator", "sources", "contentHash"].map((k) => `${JSON.stringify(k)}: ${JSON.stringify(doc[k])}`).join(",\n");
  return `{\n${head},\n"nodes": [\n${each(doc.nodes)}\n],\n"edges": [\n${each(doc.edges)}\n]\n}\n`;
}

/** Problems that fail the check (shape, seal, size, unsafe text) and warnings that do not (stale sources). */
export function validateSemantic(root, text) {
  const problems = [];
  const warnings = [];
  if (Buffer.byteLength(text) > MAX_SEMANTIC_BYTES) problems.push(`semantic.graph.json is over ${MAX_SEMANTIC_BYTES} bytes: import a smaller corpus`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problems: ["semantic.graph.json is not valid JSON"], warnings, doc: null };
  }
  if (doc.schemaVersion !== SCHEMA_VERSION || doc.layer !== "L3") problems.push(`semantic.graph.json: expected schemaVersion ${SCHEMA_VERSION} and layer L3`);
  if (doc.trust !== TRUST) problems.push(`semantic.graph.json: trust must stay \`${TRUST}\``);
  if (!doc.generator?.name) problems.push("semantic.graph.json: generator.name is missing");
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return { problems: [...problems, "semantic.graph.json: nodes and edges must be arrays"], warnings, doc: null };
  if (doc.contentHash !== seal(doc.nodes, doc.edges)) problems.push("semantic.graph.json: contentHash does not match its nodes and edges. It is written only by `import-graphify`, never by hand");
  const ids = new Set(doc.nodes.map((n) => n.id));
  for (const n of doc.nodes) {
    for (const key of ["id", "label", "path"]) if (typeof n[key] !== "string" || sanitize(n[key], 400) !== n[key]) problems.push(`semantic.graph.json: node ${n.id} has an unsafe or missing ${key}`);
    if (relativePath(n.path) !== n.path) problems.push(`semantic.graph.json: node ${n.id} has a path that is not a relative path inside the repository`);
  }
  for (const e of doc.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`semantic.graph.json: edge ${e.from} -> ${e.to} points at a missing node`);
    if (!CONFIDENCE.has(e.confidence)) problems.push(`semantic.graph.json: edge ${e.from} -> ${e.to} has no confidence label`);
    if (typeof e.source !== "string" || e.source === "") problems.push(`semantic.graph.json: edge ${e.from} -> ${e.to} has no provenance`);
  }
  const stale = [];
  for (const [path, hash] of Object.entries(doc.sources ?? {})) {
    if (!existsSync(join(root, path))) stale.push(`${path} (gone)`);
    else if (sha256(readFileSync(join(root, path))) !== hash) stale.push(path);
  }
  if (stale.length > 0) warnings.push(`semantic.graph.json is stale for ${stale.length} source(s): ${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}. Re-run the producer and \`import-graphify\``);
  return { problems, warnings, doc, stale };
}
