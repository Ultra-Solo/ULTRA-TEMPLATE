# ADR-0040: Clean a generated project of the template's meta-history at generation time

**Status:** Proposed · **Date:** 2026-11-03

## Context

"Use this template" gives an adopter a repository whose git history is already fresh: GitHub copies the default branch (or all branches, if chosen) as a single new initial commit with unrelated history, and carries no tags and no LFS objects (GitHub Docs, verified 2026-11-03; executed on a generated preset: `git log` = 1 commit, `git tag` = 0). So the git-level history problem does not exist for adopters, and the template's own history (59 commits, 44 tags) must stay immutable: pinned action SHAs ([ADR-0003](0003-pin-third-party-code.md), [ADR-0017](0017-prove-the-supply-chain-before-it-runs.md)), `pins.yml`, and every existing adopter's `.template-provenance.json` (which names an exact upstream commit, per [ADR-0023](0023-reconstruct-projects-from-exact-source.md)) all depend on those commits existing.

But an executed audit of `node template/init.mjs --preset minimal --source-commit f16ccc1…` (136 files) found file-level meta-history leaking into every generated project:

- `docs/adr/0001…0039` — all 41 template ADRs ship to the adopter.
- `docs/knowledge/graph.json` — the template's own memory graph ships as the project's seed.
- `CHANGELOG.md` — the template's pending `## [Unreleased]` entries ship; `init` only prepends its origin line.
- `.github/agents/release-cadence.agent.md` and `.github/agents/synthesis-architect-pro.agent.md` — template-operational agent files ship, and the first references `template/release-cadence.md`, which init deletes (a dangling reference).

## Decision

- Never rewrite the template's own git history. Adopter freshness is a platform guarantee; the fix is file-level and happens at generation time.
- `template/init.mjs` cleans, in `plan()`, whatever the template's own operation leaves behind:
  - `docs/adr/` is seeded to `README.md` + `0000-template.md` only — the adopter starts an empty decision log.
  - `CHANGELOG.md` is reset to its header, the release-note marker block, and a single `## [Unreleased]` holding only the `Initialized from …` origin line.
  - `docs/knowledge/` is reset to its seed documents, and the graph is regenerated for the generated tree when the knowledge feature is selected.
  - the two template-operational agent files are added to `templateOnly` in `template/features.json`, so every init deletes them.
- `template/README.md` documents that adopters should generate from the default branch only ("include all branches" copies stale branches into the new repository) and that `template-update` preserves the provenance chain.
- Identity strings may survive only where they are the provenance record itself: `.template-provenance.json`, the `Initialized from` line in `CHANGELOG.md`, and the upstream attribution in `LICENSE`.

## Alternatives considered

- **Rewriting the template's own history (filter-repo / fresh root commit)** — breaks every pinned action SHA, all 44 release tags, `pins.yml` checksum provenance, and every adopter's `.template-provenance.json` hash checks (ADR-0003, ADR-0017, ADR-0023). Rejected.
- **Shipping everything as-is** — generated projects carry the template's decisions, pending changelog entries, and a dangling reference; not a clean, ready-to-use template. Rejected.
- **Deleting `docs/adr/` from the template** — ADR-0001 requires the records to live in the template; they are the template's memory, not the adopter's. Rejected.
- **Doing nothing at git level and accepting the file leaks** — the executed audit shows real leaks (dangling ref, stale graph); rejected.

## Consequences

- Generated projects start with an empty ADR log, an empty knowledge seed, and a changelog that records only their own origin — professional, fresh, ready to use.
- The template keeps its full history, so pins, tags, and provenance keep verifying.
- `template/init.test.mjs` gains failing-first tests over all presets: no meta residue, no dangling `template/` references, identity confined to provenance/CHANGELOG/LICENSE.
- This changes generated output without changing the public contract, so it is a minor release (per the versioning table in `template/README.md`, enforced by `template-release-check`, ADR-0022).
