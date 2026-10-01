# ADR-0003: Pin third-party code by digest

**Status:** Accepted · Amended by [ADR-0015](0015-one-manifest-for-hand-pinned-tools.md) and [ADR-0017](0017-prove-the-supply-chain-before-it-runs.md) · Amended by [ADR-0024](0024-lock-runtime-security-payloads.md) · **Date:** 2026-09-15

## Context

A CI job runs with the repository's source, its token and any secret it is given. A GitHub Action referenced by tag (`@v7`) runs whatever that tag points to today; in March 2025 the tags of `tj-actions/changed-files` were repointed at a malicious commit and every workflow using them picked it up with no change in its own repository. Release binaries and container image tags can be replaced the same way.

## Decision

- Third-party actions are referenced by full commit SHA, with the version in a trailing comment: `uses: actions/checkout@<sha> # v7.0.1`. `scripts/check-hygiene.mjs` fails the build on any other form.
- Binaries downloaded in CI are verified against the SHA-256 published with the release before they run.
- Container base images carry a digest beside their tag.
- Dependencies install from committed lockfiles with `npm ci`; Go modules are checked by `go.sum` once a dependency exists.
- Dependabot proposes every bump. A pin protects only if someone reads what the new digest points to, so update pull requests get the same review as code.

Dev Container features are referenced by version tag, not digest: they shape the development environment, never what ships.

## Alternatives considered

- **Tags plus Dependabot** — convenient, and exactly the exposure described above.
- **Vendoring actions into the repository** — immune to repointing, but every update becomes a manual copy, so in practice updates stop.

## Consequences

- An upstream compromise reaches this repository only through a reviewed pull request.
- Pins age; weekly Dependabot pull requests are the cost of keeping them current.
