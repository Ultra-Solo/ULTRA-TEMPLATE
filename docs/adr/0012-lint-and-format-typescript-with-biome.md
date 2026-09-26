# ADR-0012: Lint and format the Node modules with Biome

**Status:** Accepted · Amended by [ADR-0013](0013-declare-each-fact-once.md) · **Date:** 2026-09-24

## Context

Go runs gofmt and golangci-lint, and Python runs ruff for both linting and formatting. The five Node modules ran only the type-checker. Formatting was held by habit and review, and defects a linter finds were found by nothing. The first run of a linter over them found four: two `let` declarations typed implicitly as `any`, a React effect whose dependencies were missing and which could set state after its component unmounted, and two unsafe optional chains in a test.

The Node modules install with `--ignore-scripts` and are checked with `npm audit signatures` ([ADR-0003](0003-pin-third-party-code.md)), so a tool that needs an install script, or a large dependency tree, costs more here than elsewhere.

## Decision

- Each Node module (`services/api-ts`, `services/mcp-server`, `apps/web`, `packages/ts-library`, `architecture`) depends on `@biomejs/biome`, pinned exactly, and runs `biome ci .` as `npm run lint`, first in `npm run verify`, so CI and local runs check lint and layout alike.
- Each carries a `biome.jsonc`. Its formatter settings are the style the code was already written in, so adopting it changed layout and nothing else, and the one-time reformat is its own commit. The linter uses the recommended preset. A rule is turned off only there, with the reason beside it: `useLiteralKeys` is off, because `env["PORT"]` on an index-signature record says the value may be missing.
- Biome checks JavaScript and TypeScript only. `package.json` is npm's to lay out, and a formatter that disagreed would rewrite it on every install. Sorting imports is off.
- The chassis scripts are not linted: the root `package.json` has no dependencies ([ADR-0004](0004-independent-modules.md)), and a linter there would be the first.

## Alternatives considered

- **ESLint with typescript-eslint and Prettier** — the most rules and the most common choice, and three tools with a large dependency tree per module. Type-aware rules also depend on the TypeScript compiler's API, which the native TypeScript 7 compiler these modules use does not offer in the same form.
- **oxlint with Prettier** — a fast linter, and still a second tool for layout.
- **The type-checker alone** — what v1.0.0 had; it found none of the four defects above.

## Consequences

- One small, signed dependency per module does both jobs, with platform binaries that install without a script.
- The version is exact because a formatter's output can change between releases. A Dependabot update that changes layout arrives with the reformat in the same pull request, reviewed like any other change.
- A project that takes this release with `template-update.mjs` gets the reformat of the template's own files, and its own files are checked from then on; the release notes say so.
