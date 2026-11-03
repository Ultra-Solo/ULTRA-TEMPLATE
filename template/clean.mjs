/**
 * ADR-0040: what init strips from a generated project's meta-history. A template copy's git history is
 * already fresh — GitHub copies the default branch as one initial commit — so the residue is file-level:
 * the template's own decision records, its pending changelog entries, and its own agent adapters.
 */
import { dirname, join, normalize } from "node:path/posix";
import { InitError } from "./init.mjs";

export const ADR_DIR = "docs/adr";
export const ADR_SEED = [`${ADR_DIR}/README.md`, `${ADR_DIR}/0000-template.md`];
const ADR_RECORD = /^docs\/adr\/\d{4}-[^/]+\.md$/;

/** The decision records a generated project does not inherit: every record but the seed files. */
export function adrRecordDrops(tracked) {
  return new Set(tracked.filter((file) => ADR_RECORD.test(file) && !ADR_SEED.includes(file)));
}

const UNRELEASED = "## [Unreleased]";

/** A fresh project's changelog starts at the Unreleased heading: the template's pending entries go. */
export function resetChangelog(changelog, file = "CHANGELOG.md") {
  const at = changelog.indexOf(UNRELEASED);
  if (at === -1) throw new InitError(`${file} has no "${UNRELEASED}" heading to start the project's own history at.`);
  return `${changelog.slice(0, at)}${UNRELEASED}\n`;
}

const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;
const FENCE_RE = /^\s*(```|~~~)/;
const ADR_INDEX = `${ADR_DIR}/README.md`;

/** Resolves a relative markdown link target against the linking file, posix-style; null for anchors and URLs. */
function resolveLink(file, target) {
  if (target.startsWith("#") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null;
  const path = target.split("#")[0].split("?")[0];
  if (path === "") return null;
  return normalize(join(dirname(file), path));
}

/**
 * Rewrites links that point at a dropped record: a row in the ADR index goes entirely, anywhere else the
 * link keeps its label as plain text. Fenced code blocks and inline code spans are left alone.
 */
export function rewriteDroppedAdrLinks(text, file, drops) {
  if (drops.size === 0 || !file.endsWith(".md")) return text;
  let fenced = false;
  const out = [];
  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    const spans = [];
    const masked = line.replace(CODE_SPAN_RE, (span) => `\u0000${spans.push(span) - 1}\u0000`);
    let touched = false;
    const rewritten = masked.replace(LINK_RE, (whole, label, target) => {
      const resolved = resolveLink(file, target);
      if (resolved === null || !drops.has(resolved)) return whole;
      touched = true;
      return label;
    });
    if (!touched) {
      out.push(line);
      continue;
    }
    // The index repeats each record as a linked row; with the records gone the row goes entirely.
    if (file === ADR_INDEX) continue;
    out.push(rewritten.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]));
  }
  return out.join("\n");
}
