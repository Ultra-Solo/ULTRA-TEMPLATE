# Documentation

What is written down about this repository, and how to keep it true.

| Where | What it holds |
|---|---|
| [Architecture decision records](adr/README.md) | Why the structure is what it is: one record per decision, superseded rather than rewritten |
| [Growing the CI](growing-the-ci.md) | What to change when CI gets slow — path filters, shared steps, a merge queue — without breaking the single required check |
| [Toolchain updates](toolchain-updates.md) | Every pinned version, what keeps it current, and how to move the ones nothing updates |
| [AGENTS.md](../AGENTS.md) | How to work here — the invariants the build enforces, the architecture, the conventions. Agents and people read the same file |
| Each module's `README.md` | What that module is and how to run it. Documentation about code lives next to the code |

<!-- ultra:begin template -->
[template/README.md](../template/README.md) covers the template itself: how its feature selection, marker blocks and identity replacement work.
<!-- ultra:end template -->

<!-- ultra:begin devcontainer -->
[Dev Container scan baseline](devcontainer-scan-baseline.md) records what the report-only devcontainer security scan found, and how to read the count moving.
<!-- ultra:end devcontainer -->

## Rules for changing documentation

These exist because a documentation tree decays in one particular way: not by going missing, but by growing a second page on the same subject, so that both are half true and neither is obviously wrong.

1. **Update the page that already covers the subject.** Search `docs/`, the module READMEs and `AGENTS.md` before writing anything new. A new page is for a subject none of them covers.
2. **A new page joins its index in the same change.** `scripts/check-docs.mjs` fails when a document under `docs/` is not linked from the `README.md` beside it, and when a directory's index is not linked from this one.
3. **Correct a page in place; supersede a decision.** Ordinary documentation is amended — git keeps what it said before. An accepted ADR is not: it gets a new record that supersedes it ([ADR-0001](adr/0001-record-architecture-decisions.md)).
4. **Put it where the reader will look.** Decisions in `adr/`. How to run or change one module in that module's README. Instructions for working across the repository in `AGENTS.md`. Everything else here.
5. **Delete what stopped being true.** A page kept for history reads exactly like a current one. The history is in git, and a wrong page is worse than a missing one because it is believed.
6. **Write what the build cannot check.** Prefer a check over a paragraph: a rule in `scripts/` fails on the change that breaks it, and a paragraph does not. Documentation carries the reasons, the trade-offs and what was tried — the things no check can hold.
