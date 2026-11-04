# ADR-0043: Every architecture rule ships a failing case; a structural PR carries the whole set

**Status:** Proposed · **Date:** 2026-11-04

## Context

`architecture/rules.mjs` held two rules, and `architecture/test/model.test.mjs` proved they can fail using one hand-built model that broke both at once. That proved the rules are not vacuous, but nothing ties each rule to its own failing case: add a third rule, forget the fixture, and the suite still passes. This is the failure mode Ford, Parsons, Kua and Sadalage describe for architectural fitness functions (*Building Evolutionary Architectures*, 2017): a fitness function that is not itself tested can silently stop guarding anything. Separately, AGENTS.md asks for the LikeC4 model to change in the same pull request as a structural change, but nothing holds the ADR, the rule, the docs and the knowledge graph to that same PR, so a PR can land the model change and leave the ADR or the `knowledge.mjs sync` behind.

## Decision

- `architecture/rules.mjs` exports a `violating` map: one hand-built model per rule, keyed by the rule's export name, that breaks exactly that rule. Adding a rule without an entry is a broken state.
- `architecture/test/model.test.mjs` runs two generic tests over every exported rule function: the real model satisfies the rule, and the rule's `violating` entry exists and makes the rule fire. A new rule without a fixture fails the suite.
- AGENTS.md's architecture section states the same-PR rule: a structural change carries its ADR, the model change, the rule with its failing case, the docs, and `node scripts/knowledge.mjs sync`, all in one pull request.

## Alternatives considered

- **Keep per-rule named tests and rely on review to add the fixture.** Rejected: review is not a check; the generic meta-test fails mechanically when a fixture is missing.
- **Auto-generate a violating model per rule.** Rejected: what "violating" means differs per rule, and a generated model would prove the generator, not the rule. A hand-built model is the evidence.

## Consequences

- Adding an architecture rule without a failing case fails `npm test` in `architecture/`.
- The same-PR rule is written where agents read it (AGENTS.md); enforcing it mechanically is left to PR review, recorded here as a residual human step.

## Enforcement

The meta test "every rule ships a failing case and fires on it" in `architecture/test/model.test.mjs`, run with `npm test` in `architecture/` and part of `npm run verify`, fails when a rule has no `violating` model or does not fire on it.
