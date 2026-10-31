/**
 * Bounded-artifact mutation gate — the repository's safety invariant.
 *
 * No agent may silently erase a large part of the repository in one pass. The gate is
 * diff-aware (not merely per-file): it compares HEAD against what has been staged or
 * edited since, and hard-rejects any modified file that loses more than
 * MAX_DELETION_PCT % of its lines AND more than MIN_DELETED_LINES lines unless a
 * compensating rewrite is in progress (ADDITION_PCT % of the resulting file is
 * additions). A whole file deleted is not a mutation to measure — deleting a file is
 * visible in `git status` and goes through the pull request like anything else, so
 * deletions and additions with no shared line count (a rename or a wholesale delete)
 * are reported as changes, not rejections. Below the hard band, deletions above
 * WARNING_PCT % are soft warnings.
 *
 * The gate is invoked from scripts/verify.mjs and can be installed into a pre-commit
 * hook; a machine-readable copy of the report is written to scripts/safety-report.json.
 * Pure stdlib + shell — no npm dependencies, no subprocesses into Python/LLMs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = "scripts/check-safety.mjs";

// Mayo line: 30% deletions AND >25 lines removed = reject; 20% is a soft warning band.
// These are repo invariants, not tuning knobs — changing them breaks the invariant,
// not the implementation.
export const MAX_DELETION_PCT = 30;
export const MIN_DELETED_LINES = 25;
export const WARNING_PCT = 20;
export const ADDITION_PCT = 20; // compensating rewrite guard, Mayo-true rewrite
export const REPORT = "scripts/safety-report.json";

const spawn = (await import("node:child_process")).spawnSync; // top-level await on module load

/** Run the full audit and return a report object suitable for both console and JSON. */
export function checkSafety(root = process.cwd()) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const tracked = git(root, ["ls-files", "-z"])
    .split("\0")
    .map((p) => p.trim())
    .filter(Boolean);
  if (tracked.length === 0) {
    return { ok: false, fatal: "nothing is tracked yet — run `git add -A` first." };
  }

  // The invariant is about the *change being reviewed*: diff HEAD against whatever
  // has been staged (git add), falling back to unstaged working-tree edits. Staged
  // content is read from the index, so files deleted in the tree are still measured.
  // We pass no path filter so that outright deletions (not in `ls-files`) are still
  // visible in the diff; the extension check then skips irrelevant files.
  let raw;
  try {
    raw = git(root, ["diff", "--cached", "--numstat", head, "--"]);
  } catch {
    return { ok: true, report: { changes: [], warnings: [], hardRejections: [] } };
  }
  if (!raw.trim()) {
    try {
      raw = git(root, ["diff", "--numstat", head, "--"]);
    } catch {
      return { ok: true, report: { changes: [], warnings: [], hardRejections: [] } };
    }
  }
  if (!raw.trim()) {
    return { ok: true, report: { changes: [], warnings: [], hardRejections: [] } };
  }

  // numstat: <additions>\t<deletions>\t<path>. "-" marks a side with no countable
  // text — binary, or absent on one side (a rename, a creation, a whole delete).
  const rows = raw.trim().split(/\r?\n/).filter(Boolean);
  const agg = new Map(); // path -> { del, add, uncounted, op }
  for (const row of rows) {
    const [addCol, delCol, path] = row.split(/\t/);
    if (!path) continue;
    const prev = agg.get(path) || { del: 0, add: 0, uncounted: false, op: "M" };
    if (addCol === "-" || delCol === "-") {
      prev.uncounted = true; // no shared lines to compare; keep whatever counts we have
    } else {
      prev.del += parseInt(delCol, 10);
      prev.add += parseInt(addCol, 10);
    }
    agg.set(path, prev);
  }

  // Classify the operation from the index: a file that no longer exists in the
  // index is an outright deletion and is not a mutation to measure. `name-status`
  // gives a stable D/M/A signal even when numstat collapses to "-	-".
  // Use no path filter here — deleted files are not in `ls-files`, so we need
  // all entries from HEAD vs index, including those removed.
  let rawStatus;
  try {
    rawStatus = git(root, ["diff", "--cached", "--name-status", head, "--"]);
  } catch {
    rawStatus = "";
  }
  const status = new Map();
  for (const row of rawStatus.trim().split(/\r?\n/).filter(Boolean)) {
    const [op, path] = row.split(/\t/);
    if (path) status.set(path, op);
  }

  const changes = [];
  const warnings = [];
  const hardRejections = [];
  for (const [path, { del, add, uncounted, op: numstatOp }] of agg) {
    if (status.get(path) === "D") {
      // Outright file deletion: visible in `git status`, goes through the PR
      // like anything else, so the mutation limit does not speak to it.
      changes.push({ path, deletions: del, additions: add, reason: "file removed" });
      continue;
    }

    // Count from the tree at HEAD, not the working copy: the after-content is not
    // on disk for a staged-but-not-written change, and a filtered line count keeps
    // CRLF noise from changing what "a line" means across platforms.
    const original = git(root, ["show", `${head}:${path}`], { ignore: true });
    const originalLines = original.split("\n").filter((l) => l.trim() !== "").length;
    if (originalLines === 0) continue;

    const pct = (del / originalLines) * 100;
    const isHard = pct >= MAX_DELETION_PCT && del > MIN_DELETED_LINES;
    const isWarn = pct >= WARNING_PCT && del > MIN_DELETED_LINES;

    const entry = { path, originalLines, deleted: del, additions: add, pct: pct.toFixed(2) };

    if (isHard) {
      // Compensating rewrite: if ADDITION_PCT % or more of the *original* file is
      // new text, this is a genuine replacement and the gate does not reject it.
      // Measuring against the original keeps the rule stable across edits and makes
      // a tiny deletion + a few lines impossible to pass, while still allowing a
      // rewrite that rebuilds 20% or more of the artifact from scratch.
      const addedShare = originalLines === 0 ? 0 : (add / originalLines) * 100;
      if (addedShare >= ADDITION_PCT) {
        changes.push({
          ...entry,
          severity: "rewrite-ok",
          reason:
            "compensating rewrite — additions constitute " +
            `${addedShare.toFixed(1)}% of the original file.`,
        });
        continue;
      }
      hardRejections.push({
        ...entry,
        severity: "reject",
        reason:
          `deletions (${del} lines, ${pct.toFixed(2)}% of file) exceed ` +
          `${MAX_DELETION_PCT}% and ${MIN_DELETED_LINES} lines without compensating additions.`,
      });
    } else if (isWarn) {
      warnings.push({
        ...entry,
        severity: "soft-warning",
        reason:
          `deletions (${del} lines, ${pct.toFixed(2)}% of file) exceed the ` +
          `${WARNING_PCT}% soft-warning threshold.`,
      });
    } else {
      changes.push(entry);
    }
  }

  const ok = hardRejections.length === 0;
  return {
    ok,
    report: {
      changes,
      warnings,
      hardRejections,
      head,
      thresholdPct: MAX_DELETION_PCT,
      minDeletedLines: MIN_DELETED_LINES,
      warningPct: WARNING_PCT,
    },
  };
}export function writeReport(report, root = process.cwd()) {
  const dir = join(root, dirname(REPORT));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(root, REPORT), JSON.stringify(report, null, 2) + "\n", "utf8");
}

function git(root, args, opts = {}) {
  const proc = spawn("git", args, { cwd: root, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (proc.error && !opts.ignore) {
    throw new Error(`git ${args.join(" ")}: ${proc.error.message}`);
  }
  if (!opts.ignore && proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited with ${proc.status}\n${proc.stderr}`);
  }
  return proc.stdout;
}

// CLI only: when the gate runs directly, `main` is async; when imported by tests,
// checkSafety itself must be sync so assertions do not receive a Promise. The top-
// level await only loads child_process (no await inside checkSafety), so the function
// stays synchronous.

/** CLI: run the gate and exit 0 only when there are no hard rejections. */
async function main() {
  const report = checkSafety(resolve(process.cwd()));
  writeReport(report);
  if (report.fatal) {
    console.error(`check-safety: ${report.fatal}`);
    return 2;
  }
  const inner = report.report || report;
  if (inner.hardRejections.length > 0) {
    console.error(`check-safety: REJECT — ${inner.hardRejections.length} file(s) exceed mutation limits:`);
    for (const r of inner.hardRejections) {
      console.error(`  ${r.path}: ${r.deleted} deletions (${r.pct}%) — ${r.reason}`);
    }
    return 1;
  }
  console.log(`check-safety: OK — ${inner.changes.length} changed file(s); ${inner.warnings.length} warning(s).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
