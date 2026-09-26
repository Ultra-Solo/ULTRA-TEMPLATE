# ADR-0019: Moves are compare-and-set on the store

**Status:** Accepted · Amends [ADR-0005](0005-layered-services-with-enforced-boundaries.md) · **Date:** 2026-09-26

## Context

A move was a read, a check against the rules, and a write. Two moves at once could both read the task before either wrote, both find their move legal, and both write. Of two moves to `done` from `in_progress`, both succeeded. With the in-memory stores this took two requests at the same instant. With any store that awaits I/O between the read and the write, it takes two requests close together.

The rules are the domain's (ADR-0005), and the store cannot apply them. What the store can do is refuse a write based on a read that is out of date.

## Decision

The storage port in every task service gains a replace: `Replace(task, prev)` in Go and `replace(task, prev)` in TypeScript and Python. It stores `task` only while the stored task is still `prev`, field for field. Otherwise it reports that the task is stale (`usecase.ErrStale` in Go, `false` in the others); a missing task is not found. In a database it is one conditional `UPDATE … WHERE` the old values.

A move reads the task, applies the domain's rule, and replaces. When the replace is refused, the move reads again and is judged against the task as the other change left it. So the second of two moves to `done` is refused with 409, as if it had arrived second.

Each service's conformance suite requires this of any store: a replace from a stale version is refused, and of sixteen replaces at once from one version, exactly one is made. A contract case sends sixteen moves at once and expects one 200 and fifteen 409s. The deterministic proof is in each service's use-case test, where a store holds both reads until each has happened.

## Alternatives considered

- **A lock in the use case** — it holds only within one process, so two instances of the service behind a load balancer would race again. The store is the one place both instances share.
- **A version number on the task** — it changes the wire shape and the domain, to express what comparing the stored fields already does.

## Consequences

- A move is correct under concurrency with any store that passes the suite, in one process or many.
- This is the one breaking change of 2.0.0: a store an adopter wrote must implement the replace before it compiles (Go) or type-checks (TypeScript and Python).
- A move under heavy contention may read the task more than once; each extra read follows another change that succeeded.
