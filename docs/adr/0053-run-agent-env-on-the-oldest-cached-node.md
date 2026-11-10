# ADR-0053: Run the agent environment on the oldest Node the runner caches

**Status:** Accepted · Amends [ADR-0016](0016-cloud-agents-get-the-same-toolchains.md) · **Date:** 2026-11-09

## Context

[ADR-0016](0016-cloud-agents-get-the-same-toolchains.md) wrote `scripts/agent-env.mjs` for Node 18 and the `agent-env` job in `.github/workflows/verify.yml` runs it on that major via `setup-node`. The runner pin moved to `ubuntu-26.04` ([ADR-0034](0034-move-the-runner-pin-to-ubuntu-26.04.md)), and the 26.04 image (20261101.186.1) caches only Node 22.23.4 and 24.22.2; Node 20 was removed from every runner toolcache in May 2026 (actions/runner-images#14029), so Node 18 is no longer installable there. Every pull request therefore failed `agent-env`, and with it the aggregate `verify` job: PRs #115–#120 each failed `agent-env` and `verify` between 2026-11-09 and the last green weekly run on `main` (2026-11-03).

## Decision

`scripts/agent-env.mjs` is written for Node 22 and later: `OLDEST_NODE` is 22, the oldest major the ubuntu-26.04 runner image caches, and the `agent-env` job runs it there. The comment in the script's header and the "Node 18" wording in [ADR-0016](0016-cloud-agents-get-the-same-toolchains.md) move with it; this record amends that one.

## Alternatives considered

- **Keep Node 18 and install it from nodejs.org in the job** — the job exists to prove the script runs on the oldest supported Node with nothing preinstalled; downloading Node first defeats that, and 18 is end-of-life.
- **Pin an older runner image that still caches Node 18** — contradicts [ADR-0034](0034-move-the-runner-pin-to-ubuntu-26.04.md) and reintroduces an unsupported OS.

## Consequences

- `agent-env` and `verify` run again on the 26.04 runner; the oldest supported Node is now the oldest cached one, so the claim "written for the oldest Node it runs on" stays true.
- The floor rises with the runner image: when a future image drops Node 22 from its toolcache, this record is amended again the same way.

## Enforcement

`node --test test/agent-env.test.mjs` fails when `OLDEST_NODE` is not older than the `.node-version` pin, and `node scripts/check-docs.mjs` fails when this record's status line, its `Amends` pointer, or ADR-0016's `Amended by` pointer drifts.
