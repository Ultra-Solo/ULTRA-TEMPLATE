# ADR-0016: Cloud agents get the same toolchains

**Status:** Accepted · Amends [ADR-0009](0009-where-agent-adapters-and-skills-live.md) and [ADR-0011](0011-what-local-verify-guarantees.md) · Amended by [ADR-0053](0053-run-agent-env-on-the-oldest-cached-node.md) · **Date:** 2026-09-24

## Context

A coding agent in a cloud session starts on whatever image it is given: the session that built this release found Node 22 as `node`, a golangci-lint three minor releases old on PATH, and no uv. Its first `verify` therefore refused to run, or ran checks CI does not run, until the toolchains were installed by hand. [ADR-0011](0011-what-local-verify-guarantees.md) made local verify refuse a Node other than CI's; nothing gave an agent that Node.

## Decision

`.claude/settings.json` runs `scripts/agent-env.mjs` at the start of a Claude Code session, only in the cloud (`CLAUDE_CODE_REMOTE`). From the files that pin them, it:

- installs the Node `.node-version` names from nodejs.org, checked against that release's `SHASUMS256.txt`;
- sets `GOTOOLCHAIN=auto` where a Go module is present, and installs Go from go.dev, with its published SHA-256, where there is no Go at all;
- installs the pinned tools the modules present need, from `scripts/tools/tools.json`;
- runs `setup.mjs`;
- hands PATH to the session through `$CLAUDE_ENV_FILE`.

It is written for Node 18, since it may be what installs the Node the project pins, and a CI job runs it on Node 18 and then verifies the chassis with only what it set up. check-docs fails a settings file that does not parse or a hook that runs an untracked script, which amends [ADR-0009](0009-where-agent-adapters-and-skills-live.md). `verify` also fails when a tool on PATH differs from its pin ([ADR-0015](0015-one-manifest-for-hand-pinned-tools.md)).

A checksum served from the same host as the file proves the download is whole, not who published it. Verifying Node's signed `SHASUMS256.txt.sig` would prove that, and is left for a later release.

## Alternatives considered

- **Document the setup and let the agent run it** — the agent's first attempt was the evidence that this does not happen before its first check.
- **A custom image with the toolchains baked in** — it goes stale between rebuilds, and ties the project to one hosting environment.

## Consequences

- A cloud session's first `verify` checks what CI checks.
- The session start takes longer, 20 to 30 seconds from nothing; a clear or compact keeps the container and is skipped.
- The hook is one more file an adopter may not want, and deleting it loses only the automation.
