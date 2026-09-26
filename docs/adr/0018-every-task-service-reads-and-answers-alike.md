# ADR-0018: Every task service reads a request and answers it the same way

**Status:** Accepted · Amends [ADR-0010](0010-one-statement-of-the-task-rules.md) and [ADR-0013](0013-declare-each-fact-once.md) · **Date:** 2026-09-26

## Context

ADR-0010 held every service to the same cases, but the cases checked the status and a few fields of each answer. They did not check how a body is read, which whitespace a title loses, how a time is written, what a 405 says, or what happens on SIGTERM with a request in flight. Each language's defaults filled those gaps differently:

- Go matched `"Title"` to `title` and read a byte that is not UTF-8 as U+FFFD. Python took a byte-order mark, UTF-16 and `NaN`. TypeScript and Python answered 422 to a status that was not a string, where Go answered 400.
- TypeScript's `trim` kept U+0085 and removed U+FEFF, Python's `strip` removed U+001C to U+001F, and Go's `TrimSpace` did neither. The MCP server and the web app capped a title in UTF-16 units, before trimming.
- Go wrote nanoseconds in the clock's zone, and Python wrote microseconds.
- No 405 carried `Allow`.
- TypeScript's shutdown timer overflowed at the longest timeout and fired at once. Python waited for ever on a body that never came, and exited 0 either way.
- Python's request log interleaved lines when requests ran at once.

## Decision

The contract states each of these, and the runner holds every service to it:

- **A body** is UTF-8 JSON with the documented field names spelled exactly, each of the documented type. A wrong type is 400, and a missing or null field is 422.
- **A title** is trimmed of the Unicode property `scripts/rules/task-rules.json` names (`titleWhitespace`: `White_Space`). The runner builds its cases from the property itself, and the MCP server states it as a fact. No client caps a title's length in UTF-16 units: the API checks it and says why.
- **Every JSON answer** fits the schema the OpenAPI document gives for its status. A time is UTC to the millisecond, a list is oldest first, and a 405 names the path's methods in `Allow`.
- **Shutdown:** with a request half sent, SIGTERM must leave the service up to answer it and exit 0 at the default and longest timeout, and exit 1 once the shortest has passed (`startup.stopped.abandoned`).
- The runner can also send exact bytes (`bodyHex`) and the same request many times at once (`concurrent`).

## Alternatives considered

- **Leave each language's defaults, and document the differences** — a client written against one service would break against another, which is the failure the contract exists to prevent.
- **List the whitespace characters in the rules** — a list restates the property, and it drifts from the next Unicode version. The rules name the property, and the one language without `\p{…}` lists it once, held to the cases.

## Consequences

- A client can move between the task services without meeting a difference the contract does not state.
- The contract check starts each service three more times, for the shutdown cases, which adds a few seconds per service.
- An adopter's service that relied on a language default meets new red cases on update. The adopter notes list them.
