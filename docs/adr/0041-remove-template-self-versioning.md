# ADR-0041: Remove the template's self-versioning; address a template by commit

**Status:** Proposed · Amends [ADR-0023](0023-reconstruct-projects-from-exact-source.md) and [ADR-0040](0040-clean-generated-projects-of-template-meta-history.md) · Supersedes [ADR-0022](0022-advance-the-release-when-generated-output-changes.md) and [ADR-0035](0035-drive-releases-from-a-written-standing-plan.md) · **Date:** 2026-11-03

## Context

The template was versioned like a product: 44 tags and 40+ GitHub releases, a `version` field in `template/features.json`, a `CHANGELOG.md`, a release workflow (`.github/workflows/template-release.yml`) with release-check and publication gates (`template/check-release.mjs`, `template/check-publication.mjs`), a release-cadence agent and standing plan (`.github/agents/release-cadence.agent.md`, `template/release-cadence.md`, `template/notes/`), release-please configured on the template itself, and a schema-1 provenance record that named a release tag beside the commit (ADR-0022, ADR-0023, ADR-0035).

[ADR-0040](0040-clean-generated-projects-of-template-meta-history.md) already made every generated project clean: a template copy has one fresh commit, and init deletes the template's ADRs, knowledge graph, agents, notes and changelog from it. What the version numbers were *for* — picking which snapshot an update moves from and to — is exactly what a 40-character commit SHA already does, with no release process, no publication gate, and no retaggable tag. The remaining consumers of template versions were all template-internal machinery whose only job was to produce the next number. A GitHub project template is a starting point, not a published artifact: "Use this template" copies files, not tags, so no adopter ever saw a template version; only `.template-provenance.json` did, and it always recorded the exact commit.

Security pins are not a version of the template and stay: action commit-SHA pins (ADR-0003, ADR-0017), `scripts/tools/tools.json`, `.node-version` / `go.mod` / `.python-version`, `pins.yml`, and the Dockerfile and Dev Container digests. The adopter-side release feature (`.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`) also stays: it versions the *adopter's project*, which is a real product with real releases, and is selected like any other feature.

## Decision

- The template has no version. Delete the 44 tags and all GitHub releases (GitHub-side metadata only; the commit history stays immutable, per ADR-0040), `CHANGELOG.md`, `.github/workflows/template-release.yml`, `.github/agents/release-cadence.agent.md`, `template/release-cadence.md`, `template/notes/`, `template/check-release.mjs`, `template/check-publication.mjs`, `template/release-notes.mjs`, `template/cadence.test.mjs` and their tests, and the `template-release-check` job in `verify.yml`. Remove `version` from `template/features.json` and the matching `validateManifest` check.
- Provenance schema 2: `.template-provenance.json` records `{ schemaVersion: 2, source: { url, commit }, inputs: { identity, features, year, description } }` — no tag, no version. Schema-1 records remain readable (legacy tolerance), so existing adopters keep working.
- `resolveSource(clone, { commit })` resolves only `commit^{commit}` and accepts a source manifest whose `provenanceSchema` is 1 or 2; the version-equality check goes. `init`'s default source is the upstream repository's current default-branch HEAD, resolved with `git ls-remote` — no release API, no publication check. `--source <local-path> --source-commit <sha>` remains the explicit offline and unpublished-candidate path.
- `scripts/template-update.mjs` is commit-only: `--to <40-hex|latest>` where `latest` is the source's HEAD (`git ls-remote`), `--check` compares the project's commit with upstream HEAD and exits 1 when they differ, and forward-only is enforced with `git merge-base --is-ancestor` inside the source clone, which also works for a legacy schema-1 baseline given `--legacy-commit`. CHANGELOG origin/update lines are written only when a `CHANGELOG.md` exists (legacy projects); provenance is the sole record for new projects.
- A new guard test fails if `version` returns to `template/features.json`, if `template/notes/` or any deleted release file reappears, or if a tracked file references a release tag of the template.
- Supersedes ADR-0022 (advance the release when generated output changes) and ADR-0035 (drive releases from a written standing plan); amends ADR-0023 (exact-source reconstruction becomes commit-only) and ADR-0040 (the template ships no CHANGELOG, so the origin line exists only for legacy sources).

## Alternatives considered

- **Keep template versions and only clean them from generated output (ADR-0040 alone).** The release machinery would keep running to produce numbers whose only consumer is the updater's "which snapshot" question — a question a commit SHA answers exactly. Rejected: machinery with no remaining consumer.
- **Keep a `version` in `features.json` as a counter, without tags or releases.** A counter cannot prove which commit it names, which was ADR-0022's original problem (seven commits changed generated output without a version change). Rejected.
- **Rewrite the template's git history to drop the release commits.** Already rejected by ADR-0040: pinned action SHAs, `pins.yml` checksum provenance and every adopter's `.template-provenance.json` depend on those commits existing. Tags and releases are GitHub metadata, not history; deleting them breaks nothing.

## Consequences

- Updating a generated project names commits: `node scripts/template-update.mjs --to latest` means "upstream HEAD", verified by SHA, not by a tag a retag could move.
- The template's own maintenance loses the release ceremony: changes land on the default branch and adopters pull them by commit. `template-test.yml` already generates each candidate from `--source-commit $(git rev-parse HEAD)`, so candidate commits are verified before they merge.
- Existing schema-1 provenance records and CHANGELOG origin lines keep validating on the legacy path, so no adopter project breaks.
- A guard test keeps the removal honest: the version field, the notes directory and the release workflow cannot silently return.
