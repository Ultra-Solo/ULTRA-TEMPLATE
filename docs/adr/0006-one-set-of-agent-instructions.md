# ADR-0006: Keep one set of agent instructions, and point every assistant at it

**Status:** Accepted · Amended by [ADR-0009](0009-where-agent-adapters-and-skills-live.md) · **Date:** 2026-09-17

## Context

Coding assistants read different files. Claude Code reads `CLAUDE.md`, which can import another file; Gemini reads `GEMINI.md`; GitHub Copilot reads `.github/copilot-instructions.md`; several tools read `AGENTS.md`. A repository that wants to be worked on by more than one of them needs all of those filenames to exist.

The failure this produces is not a missing file. It is four files that each say something slightly different — one updated when a rule changed, three not — with nothing in any of them saying which is current. An agent that reads the stale one is confident and wrong, and review does not catch it, because the diff that caused the drift touched a file nobody was watching.

The same drift affects two neighbouring things. A skill under `.claude/skills/` is chosen on its frontmatter name and description before its body is read, so a skill whose name does not match its directory, or whose description is missing, is invisible in a way nothing else reveals. And a document under `docs/` that no index links to is a document nobody revises: the next person writes a second page on the same subject, and both become half true.

## Decision

- `AGENTS.md` is the only file carrying instructions, and the only `AGENTS.md` in the tree.
- `CLAUDE.md` contains exactly `@AGENTS.md`, so it cannot disagree with it.
- `GEMINI.md` and `.github/copilot-instructions.md` name `AGENTS.md`, say where to look, and stay under twenty lines. Instructions written in them instead are a second set of rules.
- Every `.claude/skills/<name>/SKILL.md` has frontmatter whose `name` is its directory and whose `description` is non-empty and within the length a loader accepts.
- Every directory under `docs/` carries a `README.md` linking the documents beside it, and `docs/README.md` links each of those indexes.
- `scripts/check-docs.mjs` enforces all of it, in the chassis, on every run of `verify`.

## Alternatives considered

- **Maintain each vendor file separately** — honest about each tool's conventions, and the drift above is then a matter of discipline rather than of the build. Discipline is what this repository replaces with checks wherever it can.
- **Generate the vendor files from `AGENTS.md`** — no drift, but a generated file must be regenerated and checked, and the content is identical for every vendor, so the generator would exist to copy one file into three.
- **Nested `AGENTS.md` per module** — useful in a workspace where modules differ in tooling. Here each module already documents itself in its README, and a nested file is another copy that can contradict the root one.
- **Leave the docs index to review** — rejected for the reason in the context: the page that stops being linked is exactly the page nobody notices.

## Consequences

- An assistant reaching this repository under any of the four names is pointed at one current set of rules.
- Adding a page under `docs/` now requires adding its index entry in the same change, and adding a skill requires frontmatter. Both fail the build otherwise, which is the intent.
- The check reads Markdown links textually, so an index that refers to a document without linking it fails even though a person could follow the reference. Linking it is the cheaper fix.
- Vendor conventions change. When one of these files stops being the name an assistant reads, the list in `scripts/check-docs.mjs` is the one place to change.
