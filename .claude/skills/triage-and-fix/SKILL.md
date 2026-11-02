---
name: triage-and-fix
description: Triage a reported problem or failed check into one addressable plan, apply the fix only through scripts/search_replace.mjs (dry-run first), then verify and report exactly what ran. Use when a check fails, a bug is reported, or a maintenance task needs a bounded, auditable edit; when anything is unclear, ask the human instead of guessing. Ports mayo's scanner/executor/reviewer separation and OPEN_ISSUE escape hatch as a human-operated procedure (ADR-0039).
---

# Triage and fix

The rules for this repository are in [AGENTS.md](../../../AGENTS.md); read it first. This procedure is the human-operated form of an external engine's scan → plan → edit → review loop: you trigger each phase, and a mechanical gate judges the result ([ADR-0039](../../../docs/adr/0039-port-only-verifiable-mechanisms-from-external-engines.md)). Nothing here writes to the repository except `scripts/search_replace.mjs`, and only after a dry run.

1. **Scan.** Ask the memory what is already decided: `node scripts/knowledge.mjs query "<the problem>" --budget 1500` (see `consult-knowledge`). Read the files it cites. Collect the failure exactly as it ran: the command, its exit code, and the lines that failed. Run `git status --short` to see what is already dirty.
2. **Plan one fix.** State one addressable change: the file, the exact block to replace, and why this and not something else. If the requirements are unclear at any point, **ask** — use the ask-user tool or open an issue. Never resolve uncertainty with a guessed edit; that is the escape hatch, and guessing is what the gate exists to catch.
3. **Execute with the matcher, dry-run first.** Apply the edit only through the deterministic matcher:
   - `node scripts/search_replace.mjs --file <path> --search-file <search.txt> --replace-file <replace.txt> --dry-run` — read the printed result; if it is not exactly the intended change, fix the blocks and dry-run again. Exit 1 with a reason means the search block did not match exactly; do not fall back to another tool.
   - Only when the dry run is exact: the same command without `--dry-run`.
   - Never edit files directly, never through any other mechanism, and never write outside an entry's self-upgradeable scope in `data/plan.md` — a repair outside the plan is this same minimal pull request computed with `search_replace.mjs` (ADR-0037), not a direct write.
4. **Review mechanically.** Stage the change (`git add`) and run `node scripts/check-safety.mjs`: the mutation gate hard-rejects large deletions and any single contiguous hunk over 10 lines. Then run `node scripts/verify.mjs` (or `node scripts/verify.mjs <module>` for a one-module change). Fix the cause, not the symptom, and re-run.
5. **Report exactly what ran.** Which commands, which passed, which failed, which were skipped by name and why. A check that could not run is a failure to report, not a pass; never summarise a red run as green.
6. **Leave the lesson to a person.** If the incident or fix taught something worth keeping, suggest an episode to a human — `record-episode` says how; no agent writes `docs/knowledge/episodes` itself (ADR-0038).
