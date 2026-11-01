#!/usr/bin/env node
// check-plan.mjs — validate the self-upgrade plan record (data/plan.md) against its
// bounded schema, the same exit/semantics as scripts/check-facts.mjs:
//   0 = plan is valid and in a stable state
//   1 = plan violates its schema or drifts (entry without a closed evidence/evidence)
//   2 = cannot inspect the plan
//
// Schema per entry:
//   id       — opaque stable identifier (kebab-case), unique, non-empty
//   status   — one of: pending | in_progress | done | blocked
//   trigger  — human-readable cause; non-empty
//   verdict  — human-readable determination; non-empty
//   evidence — verifiable fact(s), one per line, prefixed:
//              PASS <test/command>
//              FAIL <test/command>
//              COMMIT <commit-ish>
//              CI    <github run url>
//              PR    <github pr url>
//              CLONE <url or "fork of ...">
//   open_issue — GitHub issue URL referencing an open issue about this entry
//                (only required when status is blocked; empty otherwise)
//
// Every entry must have all six fields. No entry drifts: a plan without entries,
// or an entry missing a field, fails hard rather than reporting unchanged output.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const PLAN_PATH = path.join(ROOT, "data", "plan.md");
const PLAN_URL = "https://github.com/Ultra-Solo/ULTRA-TEMPLATE";
const VALID_STATUSES = ["pending", "in_progress", "done", "blocked"];
const EVIDENCE_PREFIXES = ["PASS", "FAIL", "COMMIT", "CI", "PR", "CLONE"];

/** @param {string} s */
function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/** @param {string} s */
function isValidKebabId(s) {
  return /^([a-z0-9]+-)*(?:[a-z0-9]+)$/.test(s);
}

/**
 * Parse the plan markdown into entries delimited by "### <id>" headings under
 * the "## Entries" section. The template block inside the fenced "Entry
 * template" code fence is skipped so its placeholders are not read as an entry.
 */
function parsePlan(text) {
  const lines = text.split("\n");
  const entries = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      if (current !== null && !inFence) current.lines.push(line);
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!heading) {
      if (current !== null) {
        current.lines.push(line);
      }
      continue;
    }
    const level = heading[1].length;
    const title = heading[2].trim();

    if (level >= 3) {
      if (current !== null) entries.push(current);
      current = { level, title, lines: [] };
    } else if (current !== null) {
      // A level-2 heading closes the last entry's block but stays a sibling
      // section, not part of it.
      entries.push(current);
      current = null;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

/** @param {any[]} entries */
function parseFields(entries) {
  /** @type {{id?, status?, trigger?, verdict?, evidence?: string[], open_issue?}} */
  const fields = {
    id: undefined,
    status: undefined,
    trigger: undefined,
    verdict: undefined,
    evidence: [],
    open_issue: undefined,
  };

  for (const e of entries) {
    for (const line of e.lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("### ")) {
        // Nested section in a plan entry is allowed; skip its heading.
        continue;
      }

      // Top-level bullet fields: "- id: value" (key+value on one bullet)
      const fieldMatch = trimmed.match(/^-(?:\s*`(\w+)`\s*|\s*([A-Za-z_]+)\s*):(.*)$/);
      if (fieldMatch) {
        const key = fieldMatch[1] ?? fieldMatch[2];
        const value = fieldMatch[3].trim();

        switch (key) {
          case "id":
          case "status":
          case "trigger":
          case "verdict":
            fields[key] = value;
            break;
          case "evidence":
            fields.evidence = value.length ? [value] : [];
            break;
          case "open_issue":
            fields.open_issue = value;
            break;
        }
        continue;
      }

      // Evidence continuation lines inside the - evidence: list are prefixed
      // with four spaces under the parent bullet. The file may use CRLF, so
      // strip a trailing \r from the raw line before matching (a `$` anchor
      // would otherwise fail against "...text\r").
      const rawCont = line.replace(/\r$/, "").match(/^ {4}(.*)$/);
      if (rawCont && !rawCont[1].trim().startsWith("-")) {
        fields.evidence.push(rawCont[1].trim());
        continue;
      }

      // Anything else inside a heading block is ignored (paragraph text, code fences, etc.).
    }
  }
  return fields;
}

/** @param {string} line */
function parseEvidenceLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const prefix of EVIDENCE_PREFIXES) {
    if (trimmed.startsWith(prefix + " ")) return [prefix, trimmed.slice(prefix.length + 1)];
  }
  return null;
}

function isGitHubIssue(url) {
  if (typeof url !== "string") return false;
  // Must be an absolute URL beginning with PLAN_URL host.
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "github.com" ||
        u.hostname === new URL(PLAN_URL).hostname) &&
      u.pathname.startsWith("/" + new URL(PLAN_URL).pathname.replace(/^\//, ""))
    );
  } catch {
    return false;
  }
}

/** @param {string} text */
function checkPlanSchema(text) {
  if (!text) return ["plan.md is missing; inspect failed"];

  const entries = parsePlan(text);
  if (entries.length === 0) {
    return ["plan.md has no entries; schema requires at least one entry"];
  }

  const ids = [];
  const failures = [];
  const seenIds = new Set();

  for (const e of entries) {
    const f = parseFields([{ title: e.title, lines: e.lines }]);

    if (!nonEmpty(f.id) || !isValidKebabId(f.id)) {
      failures.push(
        `entry "${e.title}": id must be a non-empty kebab-case identifier`
      );
    } else if (seenIds.has(f.id)) {
      failures.push(`entry "${e.title}": duplicate id "${f.id}"`);
    } else {
      seenIds.add(f.id);
      ids.push(f.id);
    }

    if (!nonEmpty(f.status) || !VALID_STATUSES.includes(f.status)) {
      failures.push(
        `entry "${e.title}": status must be one of ${VALID_STATUSES.map(
          (s) => `"${s}"`
        ).join(", ")}`
      );
    }

    if (!nonEmpty(f.trigger)) {
      failures.push(`entry "${e.title}": trigger is required and non-empty`);
    }

    if (!nonEmpty(f.verdict)) {
      failures.push(`entry "${e.title}": verdict is required and non-empty`);
    }

    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
      failures.push(
        `entry "${e.title}": evidence is required; each line must be prefixed with ${EVIDENCE_PREFIXES.join(
          " | "
        )}`
      );
    } else {
      for (const line of f.evidence) {
        const parsed = parseEvidenceLine(line);
        if (!parsed) {
          failures.push(
            `entry "${e.title}": evidence line not prefixed with ${EVIDENCE_PREFIXES.join(
              " | "
            )}: ${line}`
          );
        }
      }
    }

    const open = f.open_issue ?? "";
    if (f.status === "blocked") {
      if (!isGitHubIssue(open)) {
        failures.push(
          `entry "${e.title}": status=blocked requires open_issue to be a valid GitHub issue URL`
        );
      }
    } else if (open.trim().length > 0) {
      failures.push(
        `entry "${e.title}": open_issue is only required for status=blocked; clear it for status=${f.status}`
      );
    }
  }

  return failures;
}

const root = process.argv[2] ?? process.cwd();
try {
  const text = fs.readFileSync(PLAN_PATH, "utf8");
  const failures = checkPlanSchema(text);

  if (failures.length > 0) {
    console.error("check-plan: plan schema violations:");
    for (const f of failures) {
      console.error("  - " + f);
    }
    process.exit(1);
  }

  console.error("check-plan: plan schema OK, " + parsePlan(text).length + " entry/entries");
  process.exit(0);
} catch (err) {
  console.error("check-plan: cannot read plan: " + err.message);
  process.exit(2);
}
