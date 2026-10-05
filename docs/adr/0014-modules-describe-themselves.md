# ADR-0014: Modules describe themselves in `module.json`

**Status:** Accepted, amends [ADR-0004](0004-independent-modules.md), [ADR-0008](0008-a-third-language-and-what-a-module-must-prove.md) and [ADR-0011](0011-what-local-verify-guarantees.md) · Amended by [ADR-0027](0027-ship-run-and-diagnose-before-the-browser-smoke-test.md) · **Date:** 2026-09-24

## Context

The list of modules and what each runs was written in five places: an array in `scripts/modules.mjs`, the task services and their start commands in `check-contract`, the modules that repeat the rules in `check-rules`, the per-toolchain step lists in `verify.mjs`, and a hand-written job per module in `verify.yml`. For Go and Python, `verify.mjs` and CI kept two lists of checks, so [ADR-0008](0008-a-third-language-and-what-a-module-must-prove.md)'s rule that local and CI run the same checks held only by care.

## Decision

A module is a directory with a `module.json`: its id, toolchain and the checks `verify` runs, and, where they apply, its `coverage`, how the contract starts it (`taskApi`), the facts it repeats (`facts`), its end-to-end check (`e2e`) and how its image is probed (`image`). The schema is closed, and `check-hygiene` fails an unknown key.

Everything reads the manifests: `scripts/modules.mjs` finds the modules, and setup, verify, the contract, the facts check and the architecture check select by what a manifest declares. Each module's CI job is a checkout and `.github/actions/module`, which sets up the module's toolchains from its manifest and runs the same `verify.mjs <id>` a contributor runs. So [ADR-0008](0008-a-third-language-and-what-a-module-must-prove.md)'s rule holds by construction.

In GitHub Actions a declared skip (a tool not on PATH, cgo missing) fails, where locally it is named and skipped. This amends [ADR-0011](0011-what-local-verify-guarantees.md): the job that should have the tool cannot pass without running it.

## Alternatives considered

- **Keep the lists, add a test that they agree** — five lists and a test is still five places to edit.
- **A matrix job over the modules** — one job name for every module breaks the rule that each module has a job of its name, which is how a missing module is noticed.

## Consequences

- Adding a module is adding its directory and a job of its name; no script or other workflow changes.
- `verify.yml` went from 387 lines to about 250, most of it one short job per module.
- The manifest is a small schema to learn, and every module has one more file.
