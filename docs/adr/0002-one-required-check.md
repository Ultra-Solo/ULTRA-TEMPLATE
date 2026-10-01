# ADR-0002: One required check, shared by CI and local runs

**Status:** Accepted · Amended by [ADR-0011](0011-what-local-verify-guarantees.md) and [ADR-0020](0020-require-generated-preset-verification.md) · **Date:** 2026-09-15

## Context

Branch protection matches required checks by job name. Requiring each job separately breaks whenever a module is added, renamed or removed: a required check that no longer runs leaves every pull request waiting, and a new job nobody added to the list never blocks anything.

Separately, a local check that runs different commands from CI drifts from it, until "passes on my machine" stops predicting anything.

## Decision

- `.github/workflows/verify.yml` ends in an aggregate job named `verify` that needs every other job and succeeds only when all of them succeeded. It is the only required status check.
- `scripts/check-hygiene.mjs` fails the build when a job in `verify.yml` is missing from `verify.needs`, so the rule does not depend on anyone remembering it.
- `node scripts/verify.mjs` runs each module's checks locally, as its CI job does. A check that cannot run — a missing toolchain, uninstalled dependencies — fails; only golangci-lint may be skipped locally, and is reported as skipped by name. The jobs that need a container engine or a CI-only tool — actionlint, zizmor, `npm audit signatures`, and building and starting each image — run only in `verify.yml`.
- Advisory workflows (`security.yml`, `codeql.yml`) are not required. They report findings and fail only when they could not run at all.

## Alternatives considered

- **Require every job** — brittle, as described above.
- **Path-filtered workflows** — a required workflow skipped by a path filter reports as pending, blocking unrelated pull requests.
- **A Makefile as the local entry point** — Windows has no `make`; Node already runs everywhere the chassis does.

## Consequences

- Branch protection is configured once and survives every change to the module set.
- A slow module slows the whole gate, because every job must finish before `verify` reports.
