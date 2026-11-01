#!/usr/bin/env node
// search_replace.mjs — deterministic surgical text replacement, ported from
// josepha-mayo/mayo `apply_surgical_edits`. No LLM, no fuzz; five ordered
// matching passes plus a catastrophic-edit guard that blocks destructive edits.
//
// Contract (same as the matcher it serves):
//   input  — full file text, kept byte-for-byte except replaced spans
//   search — the block we are trying to replace (callers strip their own
//            annotations, e.g. Mayo's [CHANGE]/[DEL]/[ADD] markers, before
//            invoking this matcher)
//   replace— the replacement block; if missing or empty, the search block is deleted
//   limit  — optional hard cap on lines removed (default: max(25, 30% of file))
//
// Returns { ok: true, result: string } or { ok: false, reason: string, ...details }.
//
// Failure mode: first match found wins, all-or-nothing, no partial edits,
// no rewriting of lines that did not participate in the match. Line endings
// are preserved (Windows \r\n vs Unix \n) per file: the replacement block
// adopts the file's native terminator, and every line keeps its own.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import process from "node:process";

/**
 * Normalize a string for comparison: collapse Windows/Unix line endings,
 * then collapse internal whitespace while preserving line structure.
 */
function normalizeForCompare(input) {
  if (input == null) return "";
  return String(input)
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/(?<=\n) +(?=\n)/g, "\n");
}

/**
 * Rstrip line endings only (Pass 1 semantics from Mayo).
 * Used as the baseline strict comparator.
 */
function rstripEndings(s) {
  return s.replace(/[\r\n]+$/, "");
}

/**
 * Compare two text blocks for equality: every character of `a` must equal the
 * corresponding character of `b`, and lengths must match.
 */
function exactMatch(a, b) {
  return a === b;
}

/**
 * Line-aware equality: match after rstrip of line endings and collapsing of
 * trailing spaces on each line.
 */
function linesEqual(a, b) {
  const la = rstripEndings(a.replace(/[ \t]+$/g, ""));
  const lb = rstripEndings(b.replace(/[ \t]+$/g, ""));
  return la === lb;
}

/**
 * Truncation artifacts that Pass 3 skips over (markers emitted by diff / LLM
 * generators instead of the real code).
 */
const TRUNCATION_PATTERNS = [
  /\.\.\.$/,
  /\[\.\.\.\]$/,
  /^(#\s*){1,3}\s*$/i,
  /^\/\/\s*\.\.\.$/,
  /^\/\*\s*\.\.\.\s*\*\//,
  /^\/\/ rest of code$/i,
  /^\/\*\s*rest of code\s*\*\//,
  /^\[CODE\]$/,
  /^\[REST\]$/,
  /^\[DEL\]$/,
  /^\[ADD\]$/,
  // A comment-only line ending in an ellipsis. Written with character classes
  // and without a redundant `\s*` before the ellipsis: the obvious
  // `(\s|\*|\/|\/\/)*` tail lets a run of slashes be split between the two
  // quantified groups in exponentially many ways, and a code line such as
  // `#...` followed by slashes then any other character hung this matcher for
  // seconds (CodeQL js/redos). The language accepted here is unchanged.
  /^(?:#|\s|\/\*|\/\/)+\.\.\.[\s*/]*$/i,
];

/** Does a line look like a truncated artifact (Pass 3 skip)? */
function isTruncationArtifact(line) {
  const t = line.trim();
  for (const p of TRUNCATION_PATTERNS) {
    if (p.test(t)) return true;
  }
  return false;
}

/**
 * Split a block into lines while keeping the exact terminator after each line,
 * so the rebuild is byte-for-byte identical apart from replaced spans.
 */
// A sentinel so load-time code cannot run outside `node --test` or a direct
// CLI invocation, and so any imported module cannot leak into the event loop
// with lingering handles from the test harness.

function splitLinesKeepEndings(text) {
  const lines = [];
  const endings = [];
  const sepPattern = /\r\n|\r|\n/g;
  let start = 0;
  while (start < text.length) {
    const match = sepPattern.exec(text);
    if (!match) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  return { lines, endings };
}

/**
 * Rebuild text from lines and a per-line terminator, honoring each line's
 * original line-ending. We never invent a trailing newline the input lacked.
 */
function joinLinesPreservingEndings(lines, endings) {
  const text = lines.join("");
  if (endings.length === 0) return text;
  // Reuse the terminator of the last line for any missing terminators,
  // preserving the file's native line-ending style.
  const effectiveEndings = [...endings];
  while (effectiveEndings.length < lines.length) {
    effectiveEndings.push(effectiveEndings[effectiveEndings.length - 1] ?? "");
  }
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i];
    out += effectiveEndings[i] ?? "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass 1 — strict contiguous block match. Mayo compares whole lines after a
// trailing-newline strip, so equality is per line, not char-run.
// ---------------------------------------------------------------------------
function pass1(lines, endings, search) {
  const slines = search.split("\n");
  if (slines.length === 0 || (slines.length === 1 && slines[0] === "")) return null;

  for (let start = 0; start <= lines.length - slines.length; start++) {
    let ok = true;
    for (let i = 0; i < slines.length; i++) {
      const a = rstripEndings(lines[start + i]);
      const b = rstripEndings(slines[i]);
      if (!exactMatch(a, b)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { start, end: start + slines.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 2 — whitespace-tolerant match. Mayo's Pass 2 strips ALL whitespace from
// each side, so both leading indentation and trailing spaces are ignored.
// Same contiguity as Pass 1.
// ---------------------------------------------------------------------------
function pass2(lines, endings, search) {
  const slines = search.split("\n");
  if (slines.length === 0 || (slines.length === 1 && slines[0] === "")) return null;

  for (let start = 0; start <= lines.length - slines.length; start++) {
    let ok = true;
    for (let i = 0; i < slines.length; i++) {
      const a = rstripEndings(lines[start + i].trim());
      const b = rstripEndings(slines[i].trim());
      if (!exactMatch(a, b)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { start, end: start + slines.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 3 — skip truncation artifacts: match the real lines of the search
// block in order, tolerating up to 3 consecutive artifact lines between them.
// The returned span replaces the whole window (artifacts included).
// ---------------------------------------------------------------------------
function pass3(lines, endings, search) {
  const slines = search.split("\n");
  const realSearch = slines.filter((l) => !isTruncationArtifact(l));
  if (realSearch.length < 2) return null;

  const n = lines.length;
  for (let cand = 0; cand < n; cand++) {
    if (isTruncationArtifact(lines[cand])) continue;
    if (!linesEqual(lines[cand], realSearch[0])) continue;
    let j = 1;
    let k = cand + 1;
    let skipped = 0;
    while (j < realSearch.length && k < n) {
      if (isTruncationArtifact(lines[k])) {
        skipped++;
        if (skipped > 3) break;
        k++;
      } else if (linesEqual(lines[k], realSearch[j])) {
        j++;
        k++;
        skipped = 0;
      } else {
        break;
      }
    }
    if (j === realSearch.length) {
      return { start: cand, end: k };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 4 — substring match across the whole flattened text. Requires exactly
// ONE occurrence. The span may straddle line boundaries; replacement rebuilds
// the affected lines.
// ---------------------------------------------------------------------------
function pass4(lines, endings, search, rawSearch) {
  // Substring substitution is only meaningful for a one-line search: with a
  // multi-line search the caller already had block passes 1-3 available, and
  // the substring pass is designed to fix LLM-given single snippets such as
  // "os.getenv("API_KEY")" without indentation.
  const slines = search.split("\n");
  if (slines.length !== 1 || slines[0] === "") return null;

  // Uniqueness and offsets use the RAW search text against the raw file: a
  // normalized substring could match inside many lines without any of them
  // actually containing it verbatim.
  const needle = rawSearch == null ? search : rawSearch;
  if (needle.length === 0 || needle.length <= 5) return null;
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) matches.push(i);
  }
  if (matches.length !== 1) return null;
  return { start: matches[0], end: matches[0] + 1 };
}

/** Which line index contains the given character offset of the joined text? */
function lineAtOffset(lines, endings, offset) {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = pos + lines[i].length + (endings[i] ?? "").length;
    if (offset < next) return i;
    pos = next;
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Pass 5 — single-line anchor. Requires exactly ONE line that equals the whole
// search (after trailing-whitespace strip). Replaces that line.
// This pass is only meaningful for a one-line search: any multi-line search
// was already handled by passes 1-3.
// ---------------------------------------------------------------------------
function pass5(lines, endings, search) {
  if (search.split("\n").length !== 1) return null;
  const anchor = rstripEndings(search.replace(/[ \t]+$/g, ""));
  if (!anchor) return null;

  const positions = [];
  for (let i = 0; i < lines.length; i++) {
    if (linesEqual(lines[i], anchor)) {
      positions.push(i);
    }
  }
  if (positions.length !== 1) return null;
  return { start: positions[0], end: positions[0] + 1 };
}

// ---------------------------------------------------------------------------
// Catastrophic-edit guard: block if the removed span exceeds the limit.
// Lines deleted = number of source lines spanned by the match.
// ---------------------------------------------------------------------------
function checkCatastrophic(fileLines, removed, limit) {
  const threshold = limit != null ? limit : Math.max(25, Math.floor(fileLines * 0.3));
  if (removed > threshold) {
    return {
      blocked: true,
      reason: `catastrophic edit blocked: would remove ${removed} line(s) from a ${fileLines}-line file (limit: ${threshold})`,
    };
  }
  return { blocked: false };
}

/**
 * Compute a minimal diff hint for debugging: how many lines differ at the
 * boundary of the match.
 */
function diffHint(lines, search) {
  const { lines: slines } = splitLinesKeepEndings(search);
  if (lines.length === 0 || slines.length === 0) return { searchLines: 0, window: 0, mismatchLines: 0 };
  const preferCrlf = lines[0].includes("\r\n");
  let mismatches = 0;
  const window = Math.min(slines.length, lines.length);
  for (let i = 0; i < window; i++) {
    const a = preferCrlf ? lines[i] : rstripEndings(lines[i]);
    const b = preferCrlf ? slines[i] : rstripEndings(slines[i]);
    if (a !== b) mismatches++;
  }
  return { searchLines: slines.length, window, mismatchLines: mismatches };
}

// ---------------------------------------------------------------------------
// Public API: search_replace(text, search, replace?, limit?)
// ---------------------------------------------------------------------------

/**
 * @param {string} text          full original text
 * @param {string} search        text block to locate
 * @param {string} [replace]     optional replacement text
 * @param {number} [limit]       optional hard cap on lines removed
 * @returns {{ok: true, result: string} | {ok: false, reason: string, details?: object}}
 */
export function search_replace(text, search, replace, limit) {
  if (typeof text !== "string") {
    return { ok: false, reason: "text must be a string", details: { got: typeof text } };
  }
  if (typeof search !== "string") {
    return { ok: false, reason: "search must be a string", details: { got: typeof search } };
  }

  // Split the search into lines and strip only line endings. Do NOT collapse
  // whitespace globally: Pass 1 requires a strict per-line rstrip match, while
  // passes 2/3 do their own tolerant comparisons. A whole-text normalization
  // would turn an indented file line into a bare string and let Pass 1 match
  // where Mayo's strict pass would reject.
  //
  // A trailing newline in the search block must NOT create a phantom empty
  // line: Mayo strips the trailing newline from the search block before
  // matching, so "line two\n" and "line two" are the same block. Normalizing
  // search here also keeps the per-pass `.split("\n")` calls consistent.
  let searchTrimmed = search;
  if (/[\r\n]$/.test(search)) {
    searchTrimmed = search.replace(/[\r\n]+$/, "");
  }
  const searchLines = splitLinesKeepEndings(searchTrimmed).lines;
  const rawSearchFirstLine = searchLines[0] ?? "";
  if (rawSearchFirstLine.length === 0 && searchLines.length <= 1) {
    return { ok: false, reason: "search text is empty after normalization" };
  }

  const { lines, endings } = splitLinesKeepEndings(text);
  if (lines.length === 0) {
    return { ok: false, reason: "input text has no lines", details: {} };
  }

  const preferCrlf = endings.length > 0 && endings[0] === "\r\n";
  const passOrder = [pass1, pass2, pass3, pass4, pass5];
  let match = null;
  let lastPass = null;

  for (const pass of passOrder) {
    match = pass(lines, endings, searchTrimmed, rawSearchFirstLine);
    if (match) {
      lastPass = pass.name;
      break;
    }
  }

  if (!match) {
    return {
      ok: false,
      reason: "no match found across all five passes",
      details: {
        search: search.replace(/\r\n|\r|\n/g, "\\n"),
        searchLines: searchLines.length,
        fileLines: lines.length,
        preferCrlf,
        passes: passOrder.map((p) => p.name),
        diffHint: diffHint(lines, search),
      },
    };
  }

  const guard = checkCatastrophic(lines.length, match.end - match.start, limit);
  if (guard.blocked) {
    return {
      ok: false,
      reason: guard.reason,
      details: {
        fileLines: lines.length,
        removed: match.end - match.start,
        threshold: limit ?? Math.max(25, Math.floor(lines.length * 0.3)),
      },
    };
  }

  const replacementLines = replace == null || replace.length === 0
    ? []
    : splitLinesKeepEndings(replace).lines;
  const replacementEndings = replace == null || replace.length === 0
    ? []
    : splitLinesKeepEndings(replace).endings;

  // Adopt the file's native terminator for any replacement lines: pass 1
  // semantics require replacement spans to match the host file's line endings.
  const nativeEnd = preferCrlf ? "\r\n" : "\n";
  for (let i = match.start; i < replacementEndings.length; i++) {
    replacementEndings[i] = nativeEnd;
  }

  const before = lines.slice(0, match.start);
  const after = lines.slice(match.end);

  const resultLines = [...before, ...replacementLines, ...after];
  const resultEndings = [...endings.slice(0, match.start), ...replacementEndings, ...endings.slice(match.end)];

  return {
    ok: true,
    result: joinLinesPreservingEndings(resultLines, resultEndings),
    details: {
      matched: true,
      pass: lastPass,
      start: match.start,
      end: match.end,
      searchLines: match.end - match.start,
      replacedLines: replacementLines.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: `node search_replace.mjs --file PATH --search TEXT [--replace TEXT]
// [--search-file F] [--replace-file F] [--limit N] [--dry-run]`
//
// On success (exit 0) writes the result to the file, or prints it to stdout
// with --dry-run. On failure (exit 1) prints reason to stderr. On misuse
// (missing args, unknown options) (exit 2).
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 */
export function main(argv) {
  const args = argv.slice(2);
  /** @type {{file?:string, search?:string, searchFile?:string, replace?:string, replaceFile?:string, limit?:number, dryRun?:boolean}} */
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" || arg === "-f") opts.file = args[++i];
    else if (arg === "--search" || arg === "-s") opts.search = args[++i];
    else if (arg === "--search-file" || arg === "-sf") opts.searchFile = args[++i];
    else if (arg === "--replace" || arg === "-r") opts.replace = args[++i];
    else if (arg === "--replace-file" || arg === "-rf") opts.replaceFile = args[++i];
    else if (arg === "--limit" || arg === "-l") opts.limit = parseInt(args[++i], 10);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "search_replace.mjs - deterministic surgical replacement (Mayo 5-pass matcher)" +
          "\n  --file PATH        file to modify (in place; use --dry-run to preview)" +
          "\n  --search TEXT      text block to find" +
          "\n  --search-file FILE read --search from this file" +
          "\n  --replace TEXT     replacement text (omit to delete the match)" +
          "\n  --replace-file FILE read --replace from this file" +
          "\n  --limit N          hard cap on lines removed; defaults to max(25, 30%)" +
          "\n  --dry-run          print the resulting text to stdout instead of writing" +
          "\n  --help, -h         show this help"
      );
      return 0;
    } else if (arg.startsWith("--")) {
      console.error("unknown option: " + arg);
      return 2;
    }
  }

  const file = opts.file;
  if (!file) {
    console.error("usage: search_replace.mjs --file PATH --search TEXT [--replace TEXT] [--dry-run]");
    return 2;
  }
  // A missing search source is a caller error, not a failed match: fail loudly
  // here rather than as "search text is empty after normalization" (exit 1),
  // which would read like the matcher looked and found nothing.
  if (opts.search == null && opts.searchFile == null) {
    console.error("usage: search_replace.mjs --file PATH --search TEXT [--replace TEXT] [--dry-run]");
    return 2;
  }

  const filePath = path.resolve(process.cwd(), file);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error("cannot read file: " + err.message);
    return 2;
  }

  const search =
    opts.searchFile != null
      ? fs.readFileSync(opts.searchFile, "utf8")
      : opts.search ?? "";

  const replace =
    opts.replaceFile != null
      ? fs.readFileSync(opts.replaceFile, "utf8")
      : opts.replace;

  const result = search_replace(text, search, replace, opts.limit);
  if (!result.ok) {
    console.error("replacement failed: " + result.reason);
    if (result.details) {
      console.error(JSON.stringify(result.details, null, 2));
    }
    return 1;
  }

  if (opts.dryRun) {
    // Byte-exact: the file write path writes result.result verbatim, so the
    // preview must agree with it rather than add a trailing newline.
    process.stdout.write(result.result);
    return 0;
  }

  fs.writeFileSync(filePath, result.result, "utf8");
  console.error("replaced " + result.details.searchLines + " line(s) in " + filePath);
  return 0;
}

// Do not run the CLI when the file is invoked as a test entry point:
// `node --test <file>` passes `--test` as argv[1], so the href check
// below would never match; guard explicitly against the runner.
const isNodeTestRunner =
  process.argv.some((a) => a === "--test" || a === "node:test" || a.includes("--test="));
if (
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  !isNodeTestRunner
) {
  process.exitCode = main(process.argv);
}

