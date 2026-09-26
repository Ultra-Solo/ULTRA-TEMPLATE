# ADR-0011: Hold local verify to CI's toolchain, and name what only CI runs

**Status:** Accepted · Amends [ADR-0002](0002-one-required-check.md) · Amended by [ADR-0014](0014-modules-describe-themselves.md), [ADR-0015](0015-one-manifest-for-hand-pinned-tools.md), [ADR-0016](0016-cloud-agents-get-the-same-toolchains.md) and [ADR-0017](0017-prove-the-supply-chain-before-it-runs.md) · **Date:** 2026-09-24

## Context

ADR-0002 made `node scripts/verify.mjs` run each module's checks "as its CI job does", so that a local pass predicts a CI pass. Three gaps undercut that:

- `verify.mjs` ran on whatever Node the machine had. A different major strips types, resolves modules and runs the test runner differently, and nothing said the result was from another runtime.
- CI ran `go test -race`, and `AGENTS.md` told contributors to, but `verify.mjs` ran plain `go test`.
- The chassis was written to run on Windows (commands through a shell where npm needs one, no symlinks, no `make`), and nothing ran it there.

Coverage was measured nowhere, and the tools pinned by hand in the workflows had no report of newer releases, so each could go stale without anyone deciding it should.

## Decision

- `verify.mjs` and `setup.mjs` compare the running Node's major version with `.node-version`, which CI's setup-node reads, and fail with the fix in the message when they differ. Only the major is compared, because CI installs the newest release of that major.
- `verify.mjs` runs `go test -race` wherever `go env CGO_ENABLED` is 1 and the C compiler Go would use is present. Elsewhere it runs `go test` and records the race detector as skipped, by name, as it already did golangci-lint. These two are the only checks that may be skipped locally, and CI always runs both.
- A `chassis-windows` job runs the hygiene and documentation checks and the chassis and template tests on `windows-latest`, and joins the gate. The modules' toolchains stay on Linux, where CI and the container images run them.
- Every module's CI job writes its line coverage to the job summary through `scripts/coverage-summary.mjs`, which reads lcov or a Go profile. Coverage is reported, never gated, and the step fails only when coverage could not be measured.
- `pins.yml` reports weekly which hand-pinned tools have a newer release (`scripts/check-pins.mjs`). It never moves a pin, and a test fails when a workflow line shaped like a pin is not in its catalogue.

## Alternatives considered

- **Compare the exact Node version** — CI does not pin one either, so an exact comparison would fail on every patch release without predicting anything more.
- **Require cgo locally** — correct on Linux and most Macs, and a failure on a default Windows machine, where the rest of verify is still worth running.
- **Run every module on Windows** — each toolchain would need its own Windows setup, and the services run in Linux containers; the chassis is the part a Windows contributor runs directly.
- **A coverage threshold** — a number that fails the build is met by tests written for the number. A report keeps the trend visible without that pressure.
- **Let Renovate move the hand pins** — possible with regex managers, but it replaces Dependabot for one class of pin, and a checksum still has to be taken from the release by someone who read it.

## Consequences

- A local pass is from the same Node major as CI's, and a missing race detector is visible in the summary rather than silent.
- Windows problems in the chassis now fail a pull request instead of reaching a contributor.
- Every module job runs its tests a second time for coverage, which costs seconds per job.
- The pin report needs network and a GitHub token to be useful; without either it fails, which says it could not look rather than that nothing is stale.
