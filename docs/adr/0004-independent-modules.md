# ADR-0004: Modules are independent and removable

**Status:** Accepted · Amended by [ADR-0013](0013-declare-each-fact-once.md) and [ADR-0014](0014-modules-describe-themselves.md) · **Date:** 2026-09-15

## Context

The repository can hold several deployable parts in different languages. A shared workspace with one lockfile couples them: removing a part means regenerating the lockfile, one broken dependency blocks installing everything, and a dependency added for one part becomes available to all of them.

## Decision

- Each module — a directory such as `services/api-go` or `apps/web` — carries its own manifest, lockfile, tests and `verify` entry point, and has its own CI job.
- No module imports code from another module's directory. Modules integrate through their public interfaces: HTTP APIs, published packages.
- `scripts/modules.mjs` lists the modules the repository can hold. Whether one is present is read from the filesystem, so deleting a module's directory removes it from `setup` and `verify` with nothing else to edit.

## Alternatives considered

- **npm, pnpm or Bun workspaces with a shared lockfile** — deduplicated installs and cross-package imports, at the cost of the coupling above.
- **One package for everything** — the simplest layout until the first second language.

## Consequences

- Removing or replacing a module is deleting a directory plus its marked lines in CI, Dependabot and documentation.
- Shared tooling such as TypeScript is installed once per module, and each module has its own Dependabot entry.
- Sharing code between modules takes deliberate work: extract a package, or call an API.
