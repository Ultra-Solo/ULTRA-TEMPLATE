# ADR-0022: Advance the release when generated output changes

**Status:** Accepted · Amends [ADR-0020](0020-require-generated-preset-verification.md) · **Date:** 2026-10-01

## Context

Initialization records the template version from `features.json`, and the updater regenerates that release as the three-way merge's baseline. Seven commits after v2.0.1 changed generated projects without changing the version. A Python preset generated at main differed from the tag in fourteen files while both recorded v2.0.1. Existing preset verification passed because it checks correctness, not whether the recorded release identifies the source.

## Decision

- A template-only `template-release-check` job feeds the required `verify` gate. It compares a PR head with its base, a merge queue head with its base, a main push with its previous head, and a manual run with the preceding commit. Missing revisions fail clearly.
- A version may not decrease. If it increases, the existing verification and release-note tests validate the candidate; an existing tag for that version must also have identical generated output. If it stays the same, each revision's own initializer generates every defined preset, each individual feature, and all features with the same explicit identity. Any generated-file change requires a version increase. New preset names and source identity changes also require an increase.
- Compare committed revisions in a private local clone without modifying source checkouts or fetching the network. Leave CHANGELOG out, as the updater and release-note comparison do: it belongs to the adopter and its origin line changes with the release itself.
- Initialization strips this job and its dependency; generated projects do not inherit template-release enforcement.
- Describe publication accurately: the release workflow runs after a merge and can fail. Until publication is confirmed, the candidate version is not a usable released baseline. For dependable initialization, use the published tag's source and confirm the release before taking an update.

## Alternatives considered

- **Only document version bumps** — the existing policy did not prevent drift from fixes and dependency updates.
- **Require a bump for every source edit** — template-only instructions and workflow wiring can change without changing a generated project.
- **Match source paths against a fixed list** — ownership, marker selection and initializer behavior determine output, so path lists miss changes.
- **Immediately replace initialization with a release-fetching bootstrap** — changes the offline and trust contract. Exact-source provenance and legacy migration need a separate compatibility decision.

## Consequences

- A generated-output change that reuses a version fails the required gate. Dependency PRs affecting generated projects must carry a version bump, or be combined into a release PR before merge.
- Unchanged-version checks generate presets and feature selections; bumped-version checks are cheap. The representative selections do not constitute exhaustive testing of every possible feature combination.
- This is an interim merge safeguard. It does not make publication atomic, authenticate release tags, automatically verify a copied template's source, or recover the exact source of legacy projects created during drift. Those remain explicit follow-on work.
