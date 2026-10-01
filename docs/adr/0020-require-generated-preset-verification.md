# ADR-0020: Require generated preset verification in the template's gate

**Status:** Accepted · Amends [ADR-0002](0002-one-required-check.md) · **Date:** 2026-09-30

## Context

The template's product is the project it generates. Its chassis tests generate presets and check their structure, but only the separate preset workflow installs dependencies and runs each generated project's complete verification. The default-branch ruleset requires only `verify`, so a failure in that separate workflow did not prevent a merge.

## Decision

- The preset workflow accepts `workflow_call`. A template-only job in `verify.yml` calls it, and the aggregate `verify` job requires that caller to succeed.
- Pull requests, pushes to `main`, and merge queue entries all reach the matrix through `verify.yml`. The preset workflow retains its weekly schedule and manual dispatch, without a second independent pull-request trigger.
- Initialization removes the caller and its `needs` entry together with the preset workflow. Generated projects retain the single `verify` check for their own modules.
- Keep the existing strict gate: failure, cancellation, or an unexpected skip cannot satisfy the required check. Regression tests prove that removing the caller from the gate is detected and that initialized projects have no dangling call.

## Alternatives considered

- **Require every preset check in the ruleset** — changing presets would require synchronized settings changes, contrary to the stable required-check contract.
- **Keep the matrix advisory** — allows changes that break a generated project to merge.
- **Copy the matrix into another workflow** — duplicates the implementation used by scheduled checks.

## Consequences

- A full preset failure blocks the same required check as a module failure.
- Main pushes and merge queue entries now pay the cost of the full preset matrix. Pull requests run it once, and concurrency cancels superseded runs.
- The reusable caller inherits read-only contents permission; timeouts remain on the called jobs.
