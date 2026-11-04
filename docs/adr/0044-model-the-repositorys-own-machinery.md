# ADR-0044: Model the repository's own machinery in the architecture model

**Status:** Accepted · **Date:** 2026-11-04

## Context

`architecture/model/system.c4` described only the system a generated project builds: the task API, the web app, the MCP server, the library. The machinery that keeps this repository itself honest — `scripts/verify.mjs` as the single gate, the `check-*.mjs` guards, the ADR records, the knowledge graph, and `template/init.mjs` — was invisible to the model, so the diagrams could not answer "who runs the gate" or "what generates a project", and a coupling between the chassis and a module (a script importing a service, a service reaching into `scripts/`) would have violated no rule. ADR-0043 made rules falsifiable; this record extends the picture they guard.

## Decision

- `system.c4` gains a second top-level system, `chassis` ("repository chassis"), with elements for the gate (`verify.mjs`), the guards (`check-*.mjs`), the decision records (`docs/adr`), the knowledge graph (`docs/knowledge`, marked with the `knowledge` feature), and the generator (`template/init.mjs`, marked `template`, together with its edge to the product), plus a `contributor` actor that uses them.
- `spec.c4` gains the element kinds `script` and `records` for those elements.
- `views.c4` gains a `machinery` view of the chassis.
- `rules.mjs` gains `chassisDecoupled`: no relationship may cross the chassis/product boundary except `chassis.template -> product`, and `undocumented` also covers the new kinds, so every chassis element states its technology and purpose. Both ship with a `violating` entry per ADR-0043.
- The README's template section diagrams the same machinery, so the prose and the model cannot drift apart.

## Alternatives considered

- **Model the chassis in a separate model directory.** Rejected: one model means the diagrams cannot drift apart (the reason architecture is code here), and `check-architecture.mjs` already holds one model to the modules present.
- **Mark the whole chassis `template`-only.** Rejected: generated projects keep `scripts/`, `docs/adr` and (with the feature) `docs/knowledge`; only the generator and the knowledge graph are removable, so only they carry markers.
- **Leave the chassis out of the model and document it only in prose.** Rejected: prose cannot fail; the `chassisDecoupled` rule with its failing case is what keeps the boundary real (ADR-0043).

## Consequences

- The LikeC4 views show both the system a project builds and the machinery that checks it; the `machinery` view isolates the chassis.
- A script that starts importing a module's code, or a module that reaches into the chassis, fails `npm test` in `architecture/`.
- The README's template section gains a diagram of the same structure, inside the `template` markers so generated projects drop it with the rest of the template prose.

## Enforcement

The generic rule tests in `architecture/test/model.test.mjs` — `npm test` in `architecture/` — fail when `chassisDecoupled` lacks its `violating` entry or does not fire on it, and when the real model breaks the rule; `node scripts/check-architecture.mjs model` (run from `architecture/`) fails when a module's element or link is missing.
