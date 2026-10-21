# ADR-0036: Record what the task contract leaves free

**Status:** Accepted · Amends [ADR-0018](0018-every-task-service-reads-and-answers-alike.md) · **Date:** 2026-10-21

## Context

ADR-0018 pinned the observables every task service must share, and [ADR-0021](0021-bound-request-receive-time.md) recorded that a timed-out request may receive a server-specific response. A verification pass at v3.13.3 — the historical bugs of ADR-0018 replayed as mutants, a 102-case corpus replayed against all three services, and fault-injected requests — then probed past those observables and found differences no case pins:

- A refused move answers 409 with a different sentence in Go ("status transition not allowed") than in TypeScript and Python ("cannot move a task from todo to done"), and the MCP server phrases its own. The runner checks that an error body is `{"error": string}`, nothing more.
- `{"status":NaN}` answers 400 everywhere, but the refusing layer differs: Go's and TypeScript's JSON parsers reject it at parse, while Python's `json.loads` accepts it as a constant and the service pins `parse_constant` to refuse it, with the field's type check refusing it after if that pin breaks.
- A request id value holding a bare carriage return or a NUL is rejected by Go's and Node's servers before the service sees it, and Python's WSGI server accepts it, after which the service replaces the id. No case sends one, for the same reason no case sends `//api/tasks`.
- All three request-log middlewares accept a backward-stepping clock and log a negative duration. Go's `time.Now` carries a monotonic reading by language semantics; TypeScript's and Python's composition roots choose their clock, and no check holds that choice.

## Decision

These differences are freedoms the contract intends, not defects. The observable stays pinned — the status, the `{"error": string}` shape, the log line — and below it each service, each server and each composition root remains free:

- Error body text is not shared. A client may show it and must not parse it.
- The layer that refuses a forbidden payload is free wherever the answer is pinned.
- Input a server classifies before the app sees it belongs to the server, as non-canonical paths already do.
- A middleware takes the clock it is given; wiring a monotonic one is each composition root's choice to make and review, not a checked invariant.

## Alternatives considered

- **Pin the error texts in the contract** — the `{"error": string}` shape already carries the guarantee a client needs, and pinned wording turns every message edit into a contract change.
- **Add cases for transport-classified input** — the contract would pin each server's socket behavior, which ADR-0018 exists to keep out of the shared surface.
- **Require a monotonic clock in a check** — the middlewares' contract is the clock they are given, and a check would pin the wiring the roots already make visible.

## Consequences

- A divergence inside these bounds is not a defect; this record is the citation.
- The Go entity suite now trims exactly the White_Space property, closing the one place a historical bug was invisible to the unit tests: the mutant that trimmed U+FEFF survived them and only the contract check caught it.
- A verifier probing past the observables reads this list instead of re-deriving it.
