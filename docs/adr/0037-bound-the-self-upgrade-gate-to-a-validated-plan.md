# ADR-0037: Bound the self-upgrade gate to a validated plan

**Status:** Accepted, amends 0011, 0020 · **Date:** 2026-02-13

## Context

The template repairs itself more each release, and a repair that edits its own invariant
checks needs a boundary: without one, a self-improving loop can grow past the checks it
was built to serve, or "fix" a failing check by weakening it. A prior attempt modeled the
loop on Mayo's self-improving maintenance engine, whose matcher is applied by an LLM
driving a prompt. An LLM in the loop cannot be held to the repository's invariants —
nothing about its output is reproducible, so nothing about it can be verified the way
every other check here is verified.

What was already in place that a gate can stand on:

- `scripts/check-safety.mjs` caps edits (30% deletion, >25 lines, 20% rewrite) and blocks
  catastrophic ones.
- The chassis runs every check from `scripts/verify.mjs`, and ADR-0020 requires generated
  presets to run the same verification, so anything wired into the chassis ships to and
  runs in every generated child.
- ADR-0002 keeps CI to one required check, so a gate must not grow a second CI job.

## Decision

The self-upgrade gate is deterministic and bounded by a written plan:

- `data/plan.md` is the gate's scope of record. Each entry (`id`, `status`, `trigger`,
  `verdict`, `evidence` with `PASS`/`FAIL`/`PR`/`CLONE` lines) states one thing the gate
  may repair and the evidence it did.
- `scripts/check-plan.mjs` validates that file — schema, status order, evidence prefixes,
  and one entry per gate check — and runs as the `chassis: plan` step of
  `scripts/verify.mjs`, so no entry drifts and no generated child runs without it.
- The matcher a repair uses is `scripts/search_replace.mjs`: the Mayo five-pass surgical
  matcher ported as a pure function — strict block, whitespace-tolerant, truncation-artifact
  skipping, unique substring (only above five characters and only when unique), and a
  single-line anchor — behind the catastrophic-edit guard. No LLM, no prompt.
- What the gate may write into itself is limited to what `data/plan.md` declares
  self-upgradeable. Everything that states a shared rule (the task rules, the contract,
  `module.json`, the hygiene rules) is repaired only by a minimal pull request computed
  with the same matcher and subject to `check-safety`'s caps.

## Alternatives considered

- **A separate CI job for the gate** — rejected: ADR-0002 requires only the `verify` job;
  a chassis step reaches every module run and every generated child without a second job
  in `verify.needs`.
- **An LLM-driven engine, as Mayo does it** — rejected: unverifiable and unreproducible;
  the matcher is the part worth keeping, and it is deterministic.
- **No plan file, gate scope in code** — rejected: the scope is a decision a reviewer
  needs to read and amend, and a plan that is not validated drifts exactly like the
  checks it governs.

## Consequences

- A generated child verifies the gate's own scope on every run, so a stale plan entry
  fails before the gate is used.
- Repairs to shared-rule files now have a defined path — minimal PR, capped diff — instead
  of ad-hoc edits during a release.
- The plan file is one more thing to keep true; `check-plan.mjs` carries that weight, and
  an entry whose evidence never ran is a lie the schema can catch only as a missing line,
  not a false one.
