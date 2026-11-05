# ADR-0046: Draw every chassis script in the architecture model

**Status:** Accepted · **Date:** 2026-11-05

## Context

ADR-0044 drew the chassis — the gate, the guards, the decision records, the knowledge graph, the generator — but linked only five files: `verify.mjs`, `check-docs.mjs`, the ADR seed, `knowledge.mjs` and `init.mjs`. The other eighteen of the twenty-three top-level scripts in `scripts/` were invisible to the model: the pinned-tool installer, the setup/environment/doctor helpers, the dev server, the repository configuration, the doc generator, the self-upgrade gate's `search_replace.mjs`, the CI probes, and the template update path. The rules from ADR-0044 and ADR-0045 constrain only relationships between modeled elements, so a script that is not drawn can import a module's code and no rule fires. `check-architecture.mjs` tied the model only to module READMEs, so the drift cost nothing.

## Decision

- `architecture/model/system.c4` draws every top-level `scripts/*.mjs` as a `link` on a chassis element, grouped by role: `verify` (the gate and the module list), `guards` (every `check-*.mjs`), `adr`, `knowledge`, `template`, and new elements for the pinned tools, the environment, the dev servers, the repository configuration, the doc generation, the self-upgrade gate, the CI probes, and the template updates.
- `architecture/rules.mjs` gains `anchored`: every built element (`service`, `webapp`, `library`, `script`, `records`) links to at least one file, with a hand-built `violating` entry per ADR-0043.
- `scripts/check-architecture.mjs` gains `checkScripts`, both directions: every `scripts/*.mjs` on disk is the target of some model link, and every model link into `scripts/` names a script that is here. Links to feature-owned scripts (`check-contract.mjs`, `check-facts.mjs`) carry the same feature markers as their paths in `template/features.json`, so a generated project keeps a link exactly when it keeps the script.
- `test/check-architecture.test.mjs` ships failing cases for both directions.

## Alternatives considered

- **One element per script.** Rejected: twenty-three near-identical nodes clutter the machinery view without adding information; grouping by role with one link per file keeps the diagram readable and the rule exact.
- **Draw only the `check-*.mjs` guards.** Rejected: the blind spot is not the guards, it is everything unmodeled — the gate's helpers, the probes, the update path; a script importing a module's code would still pass while undrawn.
- **Check only that every script is linked, not that every link exists.** Rejected: a stale link to a renamed script is the same drift in the other direction, and generated projects rely on the markers to keep the two sides in step, with the check running there too.

## Consequences

- Adding, renaming or deleting a `scripts/*.mjs` without touching the model fails the architecture check in the same change's CI.
- The machinery view shows the whole chassis, so a chassis-to-product crossing by an undrawn script can no longer hide.
- Generated projects keep the invariant automatically: a feature marker strips a link exactly when the feature's script is removed.

## Enforcement

`node scripts/check-architecture.mjs model` (run from `architecture/`, named in `architecture/module.json`) fails when a script is here but unlinked or a `scripts/` link names nothing here; `architecture/test/model.test.mjs` (`npm test` in `architecture/`) fails when `anchored` lacks its `violating` entry, does not fire on it, or finds an unlinked element in the real model; `architecture/rules.mjs` holds the rule and its `violating` map the failing case; `test/check-architecture.test.mjs` holds the failing cases for `checkScripts`.
