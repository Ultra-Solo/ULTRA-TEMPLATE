# ADR-0009: Keep skills as real files in `.claude/skills/`, and govern every agent adapter

**Status:** Accepted · Amends [ADR-0006](0006-one-set-of-agent-instructions.md) · Amended by [ADR-0016](0016-cloud-agents-get-the-same-toolchains.md) · **Date:** 2026-09-18

## Context

[ADR-0006](0006-one-set-of-agent-instructions.md) made `AGENTS.md` the only set of instructions and turned every other vendor file into a pointer. Since then the surface has grown:

- **Skills have no agreed home.** Projects keep them in the vendor-neutral `.agents/skills/`, in `.claude/skills/`, or in `skills/`. Claude Code loads `.claude/skills/`; other assistants read whatever they are pointed at.
- **Symlinks are a common bridge** — canonical skills in `.agents/skills/`, each `.claude/skills/<name>` a tracked symlink. On Windows, git checks a symlink out as a text file containing its target unless developer mode and `core.symlinks` are both on, so the skill silently disappears.
- **Copilot has its own customization directories**: `.github/agents/*.agent.md` and `.github/prompts/*.prompt.md`, selected by frontmatter. A file there is a second place instructions can accumulate.
- **Cloud agents need an environment.** GitHub's Copilot coding agent prepares its checkout with a workflow job named `copilot-setup-steps`; without one it starts with no dependencies installed and cannot run `verify`.
- **Filename mistakes are silent.** A case-insensitive filesystem tracks `agents.md` happily; the singular `AGENT.md` is a name some tools once looked for. Either one holds instructions nothing loads.

## Decision

- Skills stay in `.claude/skills/<name>/SKILL.md` as real files. They are plain Markdown, and `AGENTS.md` says where they are, so any assistant can read them; Claude Code additionally loads them by name. No symlink adapters, and no copies.
- `.github/prompts/*.prompt.md` and `.github/agents/*.agent.md` are allowed as task wrappers. Each must carry the frontmatter it is selected on and must name `AGENTS.md`; shared rules are never written there. This repository ships one, `verify-and-report.prompt.md`, which encodes the rule `AGENTS.md` states first.
- `copilot-setup-steps.yml` installs the toolchains of the selected features and runs `node scripts/setup.mjs`, the same command the Dev Container runs for a local agent.
- `scripts/check-docs.mjs` also fails on a tracked `AGENT.md`, on a case variant of `AGENTS.md` or `CLAUDE.md`, and on any relative Markdown link that does not resolve. Links inside code spans and fenced blocks are not links.

## Alternatives considered

- **Canonical `.agents/skills/` with symlinks into `.claude/skills/`** — vendor-neutral, and broken on a default Windows checkout.
- **Canonical `.agents/skills/` with copies in `.claude/skills/` and a drift check** — works everywhere, and puts every skill in the tree twice, which is the duplication ADR-0006 exists to prevent.
- **`.agents/skills/` only** — the cleanest tree, and Claude Code would not discover the skills without an adapter.
- **Forbid `.github/copilot-instructions.md`, relying on Copilot reading `AGENTS.md` natively** — plausible now, but a pointer that a check keeps to a few lines costs nothing and still helps any surface that reads only the vendor file.
- **Generated adapters with a drift check** — the right tool when an adapter must restate content. A pointer restates nothing, so there is nothing to generate.

## Consequences

- A generated project works for Claude Code, Copilot (local and cloud), Gemini and any AGENTS.md-aware tool with one set of rules and no symlinks.
- If `.agents/skills/` becomes the convention Claude Code also reads, moving the directory is a rename plus one constant in `scripts/check-docs.mjs`.
- Every relative link in the repository is now checked, including in module READMEs. A page that documents link syntax has to quote it as code, which is also how it renders correctly.
- `copilot-setup-steps.yml` has to learn each new toolchain.
<!-- ultra:begin template -->
- So does the preset job in `template-test.yml`; `template/README.md`'s checklist for adding a feature says so.
<!-- ultra:end template -->
