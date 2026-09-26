# ADR-0013: Declare each fact once, then derive it or check every copy

**Status:** Accepted, amends [ADR-0004](0004-independent-modules.md), [ADR-0010](0010-one-statement-of-the-task-rules.md) and [ADR-0012](0012-lint-and-format-typescript-with-biome.md) · **Date:** 2026-09-24

## Context

Every defect found in the v1.1.0 review had one of two causes: a fact written in two places whose copies drifted apart, or a copy that nothing compared with anything. The Python service read other scripts' digits as a port that the Go and TypeScript services refused; the MCP server reported version 0.1.0 whatever release it was; its `move_task` description restated the legal moves as prose; the Dev Container installed an unpinned uv; the default port `8080` was written in 25 files, and the longest title in a Go error message. None of these was a hard bug to fix. Each was invisible until someone happened to compare two files.

[ADR-0004](0004-independent-modules.md) requires each module to stay independent and deletable, so a module cannot import a shared constant from another; some copies are the price of that independence.

## Decision

Every fact that more than one file depends on is declared exactly once. Every other place either:

- **derives it** when it runs or is generated — the chassis scripts, CI and the documentation read the declaration; or
- **keeps its own copy and is checked against the declaration**, only where a module must stay independent.

| Fact | Declared in | Copies held by |
|---|---|---|
| Modules, their checks and capabilities | `<module>/module.json` ([ADR-0014](0014-modules-describe-themselves.md)) | derived by every script and CI job |
| Hand-pinned tools | `scripts/tools/tools.json` ([ADR-0015](0015-one-manifest-for-hand-pinned-tools.md)) | derived; hygiene rule 16 fails a pin written elsewhere |
| Toolchain versions | `.node-version`, `go.mod`, `.python-version`, `pyproject.toml` | hygiene rule 17 |
| Task rules | `scripts/rules/task-rules.json` | the contract's move cases; `check-facts` |
| Limits, configuration, startup and shutdown | `scripts/contract/tasks-api.json` | the contract run and the image probe; `check-facts` for the API's default port |
| Lint and format settings | the root `biome.jsonc` | derived through `extends` |
| Values the documentation states | their source files | generated blocks; check-docs rule 10 |
| Each decision's status | its record's `**Status:**` line | the ADR index's status column; check-docs rule 11 |

`check-rules` becomes `check-facts`, since the facts a module repeats are no longer only the rules. The contract's cases refer to a limit as `{ "ref": "limits.maxBodyBytes", "plus": 1 }` and never restate it; the runner refuses a count written as a number.

Not counted as a copy: a protocol constant (an HTTP status, `"jsonrpc": "2.0"`), a test input whose point is its literal value, and a module's constant, whose behaviour the contract checks.

## Alternatives considered

- **A shared constants package every module imports** — breaks [ADR-0004](0004-independent-modules.md): a module could no longer be kept or deleted alone.
- **Code generation into each module** — a generated file is a copy with a build step in front of it; checking the copy costs less and leaves each module readable on its own.
- **Leave it to review** — the review that found these defects is the evidence that review does not find them.

## Consequences

- Changing a fact means changing its declaration, and the checks name every place still on the old value.
- A module keeps the copies it needs to stand alone, and each one has a check beside it.
- There are more checks to keep, and each has a test that shows it failing.
- An adopter who edited a copy by hand meets a check where there was none; the release notes say which.
