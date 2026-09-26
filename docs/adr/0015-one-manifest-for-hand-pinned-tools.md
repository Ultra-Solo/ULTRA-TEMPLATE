# ADR-0015: Hand-pinned tools live in one manifest

**Status:** Accepted, amends [ADR-0003](0003-pin-third-party-code.md) and [ADR-0011](0011-what-local-verify-guarantees.md) · Amended by [ADR-0017](0017-prove-the-supply-chain-before-it-runs.md) · **Date:** 2026-09-24

## Context

Eight tools Dependabot cannot see were pinned in six files, in five formats: an env variable and a SHA-256 in one action, an action's `version:` input, a `@v…` in a `go run` line, a `==` in a `uvx` line. The weekly pin report had to recognise each with a regular expression of its own; the Dev Container installed uv and golangci-lint at whatever was newest; and nothing compared a golangci-lint on a developer's PATH with the one CI ran. This sandbox's own 2.5.0 cannot lint a Go 1.26 module.

## Decision

Every hand-pinned tool is declared once, in `scripts/tools/tools.json`: its version, where it is needed, where its releases are, and, for a downloaded binary, the asset and its SHA-256 for each platform it is installed on (Linux x64 and arm64, macOS arm64), taken from the release itself — its checksum file, a checksum beside each asset, or the digest GitHub records. `scripts/tools.mjs` installs a tool only after checking that SHA-256, runs the tools used by version, and moves a pin with `bump`, which takes the new checksum from the release and never from anywhere else.

- Hygiene rule 16 fails a version written into a workflow or action instead.
- Hygiene rule 17 holds each toolchain version's copies to its declaration, and the Dev Container's golangci-lint and uv to the manifest.
- `verify` fails when a tool on PATH is not the pinned version, and names the command that installs it.
- A tool whose check runs another command only when it is on PATH lists it under `uses`. `verify` reports each one missing as a skip, which fails in CI, and fails one pinned here at another version; installing the tool installs the ones pinned here with it. actionlint checks each `run:` script with shellcheck this way. A runner's own shellcheck turned a workflow red that `verify` had passed on a machine without one, so shellcheck is pinned too, and CI, local runs and an agent's session lint the workflows with the same one.

zizmor's arm64 and macOS assets are not pinned: its release publishes no checksum file, and GitHub's recorded digest could not be read from where this was written. `install --local` reports that and installs the rest.

## Alternatives considered

- **Keep each pin where it is used, and make the report smarter** — the report would still restate each location, and a local install would have nothing to read.
- **mise or asdf for the tools** — another tool to install before the first one, without per-asset checksums from the release.

## Consequences

- One place to read and move every pin, and a command that moves it.
- Local runs, CI and an agent's session install the same binaries, checked the same way.
- Adding a platform means adding its asset and checksum; `bump` fills them in from the release.
