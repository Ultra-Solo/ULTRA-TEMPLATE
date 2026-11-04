# ADR-0042: Make every ADR falsifiable: a full status grammar and a required Enforcement section

**Status:** Accepted · **Date:** 2026-11-04

## Context

ADR-0001 made records immutable and `scripts/check-docs.mjs` holds the index to each record's status line (rules 11–12). Two gaps remain. The grammar in `0000-template.md` offers only `Proposed | Accepted | Superseded by ADR-NNNN`: there is no status for a decision that was withdrawn without a replacement (`Deprecated`) or one whose option was rejected outright, so a rejected or abandoned mechanism leaves no trace and reads as if it were never considered. And an accepted structural ADR can name a rule that nothing enforces: delete the rule and no check fails, so the record decays into prose. MADR's lifecycle (adr/madr, release 4.0.0, 2024-09-17) includes exactly these terminal states, which this grammar lacks.

## Decision

- The status grammar in `0000-template.md` becomes `Proposed | Accepted | Deprecated | Rejected | Superseded by ADR-NNNN`, with the existing `Amends` / `Amended by` clauses unchanged. A new rule 13 in `scripts/check-docs.mjs` fails any record whose status starts with a word outside this grammar.
- Every record from ADR-0042 on carries a `## Enforcement` section naming, in backticks, the check or test that fails when the decision is undone — a command (for example `node scripts/check-docs.mjs`) or a tracked file (for example `architecture/test/model.test.mjs`). Rule 13 fails a record that lacks the section, leaves it empty, names nothing, or names a path that is not tracked. Records before 0042 are grandfathered: ADR-0001 forbids rewriting accepted records, and their decisions are already held by the checks that existed when they were accepted.
- `0000-template.md` gains the grammar and the section, so every new record starts falsifiable.

## Alternatives considered

- **Backfill an Enforcement section into all 41 existing records.** Rejected: ADR-0001 forbids rewriting accepted records, and amending 41 of them buys a property only new decisions need. A number threshold is deterministic and self-documenting.
- **Require Enforcement only in "structural" records, detected by keyword in the title.** Rejected: keyword detection is guesswork that drifts; every ADR shapes the repository, so every new one names its check.
- **Let the Enforcement section be free prose.** Rejected: prose cannot fail. Requiring a backticked command or a tracked file makes the section itself checkable.

## Consequences

- A rejected or withdrawn decision is recordable without inventing a superseding record, and the index shows it in lockstep as before.
- Every new structural decision is falsifiable on day one: delete its enforcement and `node scripts/check-docs.mjs` fails.
- Reviewers can tell a guarded decision from an unguarded one by reading the record.

## Enforcement

Rule 13 of `scripts/check-docs.mjs`, run with `node scripts/check-docs.mjs`, fails a status outside the grammar and any record from ADR-0042 on whose `## Enforcement` section is missing, empty, names nothing, or names an untracked path.
