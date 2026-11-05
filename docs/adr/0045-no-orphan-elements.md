# ADR-0045: No element floats without a relationship

**Status:** Accepted · **Date:** 2026-11-05

## Context

`architecture/rules.mjs` held three rules: elements must be documented, no service may depend on a web app, and nothing may cross the chassis/product boundary except the generator. None of them noticed a built element with no relationship at all. Running a candidate "orphaned" check over the real computed model found exactly one: `product.tsLibrary`, drawn in `system.c4` but connected to nothing, so every diagram showed it as a floating node that no consumer and no dependency explains.

## Decision

- `rules.mjs` gains `orphaned`: every element of a built kind (`service`, `webapp`, `library`, `script`, `records`) must appear as the source or target of at least one relationship, and the rule ships with a `violating` entry per ADR-0043.
- `system.c4` connects the one offender in the same change: `user -> tsLibrary` ("installs it from npm to offer only the legal status moves"), so the model and the rule change in one pull request.
- `architecture/README.md` names the new rule beside the others.

## Alternatives considered

- **Only document that ts-library is a published artifact.** Rejected: prose cannot fail; a rule with a failing case is what keeps the next orphan out of the diagrams (ADR-0043).
- **Exclude `library` from the rule.** Rejected: a published package is exactly the kind of element whose consumer edge matters; the rule covers every built kind.
- **Count containment in a system as a relationship.** Rejected: nesting already implies "part of", and the rule is about real dependencies and uses between elements.

## Consequences

- Any future element added to the model without an edge fails `npm test` in `architecture/`, so the diagrams keep showing only connected architecture.
- `product.tsLibrary` gains its consumer edge, making the "who uses the package" question answerable from the views.

## Enforcement

`architecture/test/model.test.mjs` (run by `npm test` in `architecture/`) fails when `orphaned` lacks its `violating` entry, does not fire on it, or finds an orphan in the real model; `architecture/rules.mjs` is the rule and its `violating` map the failing case, both tracked files named here.
