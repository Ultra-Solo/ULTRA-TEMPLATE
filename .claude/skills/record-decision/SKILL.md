---
name: record-decision
description: Write an architecture decision record when a change alters structure, a dependency direction, or a tool other code relies on. Use before merging such a change, or when asked why something is built the way it is.
---

# Record a decision

1. Copy `docs/adr/0000-template.md` to the next free number: `docs/adr/NNNN-title-in-the-imperative.md`.
2. Fill it in:
   - **Context** — the forces behind the decision and anything that already went wrong. Facts, not advocacy.
   - **Decision** — stated so that someone reading only this section knows what to do.
   - **Alternatives considered** — each one with the reason it lost.
   - **Consequences** — what becomes easier, and what it costs, stated plainly.
3. Add its row to the table in `docs/adr/README.md`, with the status its record states, written short: `Accepted, amends 0003` for `Accepted · Amends [ADR-0003](…)`. `scripts/check-docs.mjs` fails a row that says anything else.
4. Changing an accepted decision: write a new ADR that supersedes or amends it (`Supersedes`, `Amends` on the new record's status line), add `Superseded by` or `Amended by` and a link to the new record to the old record's status line, and update both rows. Never rewrite the old text; its reasoning is the record. `scripts/check-docs.mjs` fails a pointer missing at either end.
5. Ship the ADR in the same pull request as the change it explains.
