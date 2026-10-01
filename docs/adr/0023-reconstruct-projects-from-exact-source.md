# ADR-0023: Reconstruct projects from exact source

**Status:** Accepted · Amends [ADR-0022](0022-advance-the-release-when-generated-output-changes.md) · **Date:** 2026-10-01

## Context

A copied template has new Git history. Its manifest version previously named a release even when main had different generated output or that release had not yet been published. The updater also returned already-current before checking a tag. Version-only CHANGELOG records cannot recover the source or original identity of ambiguous legacy projects. Regeneration in a later year could change the adopter's license notice.

## Decision

- Initialization is a bootstrap. Its default checks stable GitHub publication for the copied manifest's version, resolves that upstream release tag and generates with that committed snapshot's renderer. It never uses a template copy's HEAD as upstream provenance. Missing publication or source stops before adopter files change.
- A versioned `.template-provenance.json` record stores source URL, version, full commit, tag, original identity, features, description and copyright year. Add the record after identity substitution; its fixed filename must not contain a replaceable project identity. CHANGELOG remains the human-readable history.
- An explicit local mirror can supply a checked release tag offline. `--source <local-path> --source-commit <full-sha>` selects a committed unreleased snapshot, records a null tag and labels its human origin as source rather than a published release. Git object identity is checked before executing its renderer. Symlinks and submodules are refused.
- Before any generation, the updater checks availability, manifest version and the recorded tag-to-commit relationship for the baseline and optional `--to-commit` for the target. Even an already-current update verifies its source. Regeneration uses the saved inputs, so repository renames, custom descriptions and later calendar years cannot silently redefine the baseline.
- Legacy records require a reviewed `--legacy-commit`; this acknowledges a tagged baseline, not proof that ambiguous old main output matched it. Retain the legacy CHANGELOG reader and three-way merge, deletion protections, dry runs and conflict handling. Migration with an ambiguous baseline remains a manual repair. This compatibility change is v3.0.0.
- The required release guard and note generator use explicit committed candidate snapshots offline. Exclude provenance metadata from generated-output diffs, as with CHANGELOG, because its commit changes for template-only edits. Other generated files still determine whether a bump is required.

## Alternatives considered

- **Record the copied repository's HEAD** — it cannot be fetched as the upstream baseline.
- **Record a commit without resolving generation from it** — this can identify source that never produced the output.
- **Continue trusting legacy versions automatically** — the reproduced main-versus-tag drift makes that assumption ambiguous.
- **Replace the generator or updater** — the existing feature filtering and three-way merge work when their inputs are reconstructible.
- **Force network access for every use** — explicit local mirrors and commit snapshots support offline work and unpublished CI candidates.

## Consequences

- New projects have a reconstructible baseline. A moved tag or unavailable source fails before executing unexpected initializer code or changing adopter files.
- Default initialization requires network access and completed stable publication. Candidate CI uses explicit SHA inputs; the release gate still requires versioned generated-output changes.
- The first source resolution trusts the publisher and transport; hashes do not authenticate authorship. Explicit mirrors are code execution trust decisions. This does not sandbox renderer code or recover absent legacy evidence.
- Legacy migration needs review and the new updater plus its shared source helper. Supported source history must remain available; tags should be protected from modification and deletion.
