# ADR-0027: Ship run and diagnose before the browser smoke test

**Status:** Accepted · Amends [ADR-0026](0026-remap-the-foundation-milestones-to-versions.md) and [ADR-0014](0014-modules-describe-themselves.md) · **Date:** 2026-10-04

## Context

[ADR-0026](0026-remap-the-foundation-milestones-to-versions.md) moved milestone B — the run/diagnose/maintain work — to v3.5.0, unchanged in content. Looking at the four items together before building them:

- **B1 (dev runner), B3 (doctor) and B4 (update discovery) are root-tooling work.** No new dependencies, no new CI jobs, no new modules: they extend scripts the repository already owns and tests (`modules.mjs`, `template-update.mjs`, `template-source.mjs`, `tools.mjs`), and their failure modes are ordinary — a command that exits non-zero, a JSON shape that drifts.
- **B2 (browser smoke test) is the only item that changes the CI topology.** Nothing in this repository runs a browser today; B2 needs one in CI, a new dependency in `apps/web`, and a new harness. [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) already named the cost: "browser tests need isolation/readiness investment". A flake there lands inside the required `verify` gate — the same gate A4r just made publication depend on — so a flaky browser job can block a release.
- **The precedent is recorded.** [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) planned A1–A5 as one v3.3.0; reality shipped A1 as v3.3.0 and the rest as v3.4.0, and [ADR-0026](0026-remap-the-foundation-milestones-to-versions.md) recorded the lesson. Planning the split from the start costs less than discovering it mid-release.
- **B1 needs each module to state how it runs in development.** [ADR-0014](0014-modules-describe-themselves.md) closed the `module.json` schema — id, toolchain, checks, coverage, taskApi, facts, e2e, image — so the runner cannot learn a dev command from anywhere without extending the schema.

## Decision

- **v3.5.0 ships B1, B3 and B4**: the dev runner (`scripts/dev.mjs`), the read-only doctor (`scripts/doctor.mjs`), and `--check` update discovery in `scripts/template-update.mjs`.
- **B2 moves to v3.6.0**, unchanged in content. Whether its harness builds on the dev runner or starts its own stack the way `check-contract --e2e` does is decided in that release's investigation, not now.
- **`module.json` gains an optional `dev` key**: `{"run": [command, …args]}` states how the module runs in development. The schema stays closed and `check-hygiene` still fails an unknown key; a module without `dev` is not runnable by the dev runner, and the runner says so.

## Alternatives considered

- **Ship B1–B4 as one v3.5.0, per ADR-0026** — Rejected: the release's landing would depend on its riskiest item — a new browser dependency and CI story whose flakes land inside the gate publication now waits on.
- **Ship B2 first, as v3.5.0** — Rejected: it is the only item with new dependencies and a CI-topology change; holding three zero-dependency items behind it buys nothing.
- **Drop B2** — Rejected: [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md)'s reasoning stands — a real browser-to-API journey is the only proof the web app and a task service work together as shipped. It is deferred, not deleted.
- **Hard-code the dev commands in `scripts/dev.mjs`** — Rejected: that is a second list of what modules run, exactly what [ADR-0014](0014-modules-describe-themselves.md) removed when five lists became the manifests.

## Consequences

- **Easier**: v3.5.0 is zero-new-dependency, zero-CI-topology-change work that keeps the release cadence; B2's Chromium story and flake behavior are then observed in isolation, on top of a runner it can reuse if that investigation chooses.
- **Harder, or costs**: the browser smoke waits one release; the `module.json` schema grows one key, and every module that wants dev-runner support states its own command.
