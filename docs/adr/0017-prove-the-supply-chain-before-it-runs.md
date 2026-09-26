# ADR-0017: Prove every pin before it runs, not where it first runs

**Status:** Accepted · Amends [ADR-0003](0003-pin-third-party-code.md), [ADR-0011](0011-what-local-verify-guarantees.md) and [ADR-0015](0015-one-manifest-for-hand-pinned-tools.md) · **Date:** 2026-09-26

## Context

ADR-0003 pinned third-party code and ADR-0015 put every hand-pinned tool in one manifest, but several pins were first exercised by the person or workflow that depended on them:

- CI installed only the linux-x64 asset of each tool, so eight arm64 and macOS checksums were first checked on a contributor's machine.
- uv reached CI through `astral-sh/setup-uv`, at the pinned version but from a download nothing checked.
- Dependabot's github-actions entry read only `/`, so the actions pinned inside `.github/actions/*` never moved with the workflows' pins.
- The Dev Container named its base image by tag.
- A `v*` tag could be moved or deleted, and any branch could deploy to the publishing environments.
- The only blocking secret scan was GitHub's push protection, which a private repository without Advanced Security does not have.
- CI linted the workflows in a hand-written actionlint job, so `verify` and CI described the same check twice.

## Decision

A pin is proven where it is declared, before anything depends on it:

- `node scripts/check-pins.mjs --checksums` compares every pinned SHA-256, for every platform, with the one the release publishes. The `checksums` job in `pins.yml` runs it on each pull request that changes a pin, and weekly. It is outside the gate because it depends on hosts this repository does not run. A new platform's checksum is taken from its output, which is how zizmor's arm64 and macOS assets are now pinned.
- A tool in `tools.json` lists the setup actions that would install it outside its pin (`actions`), and hygiene rule 16 fails a workflow that uses one.
- Hygiene rule 19 fails an action pinned at two SHAs, and a directory holding an `action.yml` that Dependabot's github-actions entry does not list. Every update entry waits seven days (`cooldown`), which zizmor checks.
- Hygiene rule 14 covers the Dev Container: its base image comes from `.devcontainer/Dockerfile`, by digest, and Dependabot's docker entry proposes new ones.
- `configure-github.mjs` adds a ruleset that keeps release tags from being moved or deleted, and limits each deployment environment a workflow names to the default branch.
- The `secrets` job in `verify.yml` runs the pinned gitleaks over the commits each change adds, and blocks. The history scan in `security.yml` stays report-only.
- CI's `chassis` job installs the chassis tools and runs them through `verify`, where a missing one fails in CI unless the manifest has no asset for that platform. There is no separate actionlint job.

## Alternatives considered

- **Download every platform's asset in CI and hash it** — that proves the download matches itself, not that it matches what the project published. The release's own checksum is the reference ADR-0015 chose.
- **Keep setup-uv and pass it the pinned version** — the version would agree, but the binary would still be one nothing checked.
- **Block on the full-history secret scan** — an untuned scanner that turns red on old history teaches everyone to ignore it. The change's own commits are what a pull request can fix.

## Consequences

- Every pinned checksum, action SHA and image digest is either compared with its source by a job or refused by a hygiene rule.
- The checksums job and the weekly report depend on GitHub, PyPI and the tools' release hosts. They are not in the gate, so an outage delays that evidence without blocking merges.
- A false positive in the secret scan blocks the change until it is silenced in `.gitleaksignore`, with a reason.
- An adopter's workflow that uses setup-uv, or a local action outside Dependabot's list, turns red on update.
