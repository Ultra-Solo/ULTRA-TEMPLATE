# ADR-0047: Draw every workflow and every scripts/ file in the architecture model

**Status:** Proposed · Amends [ADR-0046](0046-draw-every-chassis-script-in-the-model.md) · **Date:** 2026-11-05

## Context

ADR-0046 drew every top-level `scripts/*.mjs` as a link on a chassis element and made `check-architecture.mjs` hold the model to them in both directions. Two blind spots remained. First, `scripts/` grew subdirectories — `scripts/contract/` (the task API contract), `scripts/rules/` (the one statement of the task rules), `scripts/tools/tools.json` (the pinned-tool checksums), `scripts/hooks/` (the installable git hooks), `scripts/knowledge/` (the graph's implementation) — and none of those files was drawn, so the checker could not see them either: `chassisScripts()` read only the top level. Second, the CI workflows in `.github/workflows/` — twelve of them, including the single required `verify.yml` and the security scans — were entirely outside the model, so a workflow could change what the repository guarantees without any rule firing. The same drift ADR-0046 closed for top-level scripts was still open one level down and one directory over.

## Decision

- `scripts/check-architecture.mjs` enumerates tracked files instead of a top-level listing: `chassisFiles()` returns every file under `scripts/` at any depth, `workflowFiles()` every `.yml` in `.github/workflows/`. Both go through git (`git ls-files`) when the checkout is a work tree, so gitignored artifacts such as `scripts/safety-report.json` are not drawn; outside a work tree it falls back to the files on disk, which is what a freshly generated project has. One `checkTree` helper holds both directions for each directory: every tracked file there is the target of some model link, and every model link into that directory names a file that is here.
- `architecture/model/system.c4` draws the new files: the contract and rules files on `guards` behind the six service/client feature markers that own them, `scripts/tools/tools.json` on `tools`, the `scripts/knowledge/*.mjs` implementation on `knowledge`, the git hooks in a new `hooks` element (the knowledge hook behind the `knowledge` marker), `verify.yml` on `verify`, and all twelve workflows in a new `ci` element with `ci -> verify` — the core workflows unconditionally, `architecture.yml`, `devcontainer-scan.yml`, `mcp-publish.yml`, `release.yml` behind their feature markers, and `template-test.yml` inside the existing `template` element. Feature-marker wrapping follows `template/features.json`, so a generated project keeps each link exactly when it keeps the file.
- `test/check-architecture.test.mjs` ships failing cases for both directions of both trees, including a subdirectory file.
- No change to `architecture/rules.mjs`: the new `hooks` and `ci` elements are `script` kind and satisfy the existing `undocumented`, `anchored` and `orphaned` rules by stating technology, description, a link and a relationship.

## Alternatives considered

- **Draw only the workflows.** Rejected: the subdirectory files carry the same hazard — `scripts/contract/tasks-api.json` is the source of truth the contract check holds every service to, and an undrawn file is an invisible crossing.
- **Enumerate the working tree, gitignored files included.** Rejected: `scripts/safety-report.json` is a generated artifact of the safety hook, not repository structure; the model describes the repository, so the enumeration follows git.
- **A rule per file kind in rules.mjs.** Rejected: the module/anchor discipline is enforced by `check-architecture.mjs` against the real tree, not by a hand-built model rule; one `checkTree` over two directories is exact and cheaper than two new rules with failing cases.

## Consequences

- Adding, renaming or deleting any file under `scripts/` or any workflow in `.github/workflows/` without touching the model fails the architecture check in the same change's CI, in both directions.
- The `machinery` view now shows the CI itself and the git hooks, so the model covers the whole enforcement surface, not only the guards.
- Generated projects keep the invariant automatically: a feature marker strips a link exactly when the feature's file is removed, and the check runs there against the generated tree.

## Enforcement

`node scripts/check-architecture.mjs model` (run from `architecture/`, named in `architecture/module.json`) fails when a tracked file in `scripts/` or a workflow in `.github/workflows/` is here but unlinked, or when a link into either directory names nothing here; `test/check-architecture.test.mjs` holds the failing cases for `checkScripts` (including a subdirectory file) and `checkWorkflows` in both directions; `architecture/test/model.test.mjs` (`npm test` in `architecture/`) still proves `anchored` and `orphaned` fire on the new `hooks` and `ci` elements.
