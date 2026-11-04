# ADR-NNNN: Title in the imperative, stating the decision

**Status:** Proposed | Accepted | Deprecated | Rejected | Superseded by ADR-NNNN, then `· Amends ADR-NNNN` for each record this one changes, and later `· Amended by ADR-NNNN` for each record that changes this one (link each as `[ADR-NNNN](NNNN-title.md)` with the real number) · **Date:** YYYY-MM-DD

## Context

What forces this decision: the problem, the constraints, and anything that already went wrong. Facts, not advocacy.

## Decision

What was decided, stated so that someone reading only this section knows exactly what to do.

## Alternatives considered

- **Option** — why it was not chosen.

## Consequences

- What becomes easier.
- What becomes harder, or what this costs, stated plainly.

## Enforcement

The check or test that fails when this decision is undone, named in backticks: a command (for example `node scripts/check-docs.mjs`) or a tracked file (for example `architecture/test/model.test.mjs`). Required in every record from ADR-0042 on; `scripts/check-docs.mjs` fails a record that lacks this section, leaves it empty, or names a path that is not tracked.
