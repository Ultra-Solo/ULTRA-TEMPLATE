# ADR-0010: State the task rules once, and hold every copy and the API contract to that statement

**Status:** Accepted · Amends [ADR-0005](0005-layered-services-with-enforced-boundaries.md), [ADR-0007](0007-mcp-server-as-an-adapter.md) and [ADR-0008](0008-a-third-language-and-what-a-module-must-prove.md) · Amended by [ADR-0013](0013-declare-each-fact-once.md) and [ADR-0018](0018-every-task-service-reads-and-answers-alike.md) · **Date:** 2026-09-24

## Context

The task rules (which statuses exist, which moves between them are legal, how long a title may be) are repeated in every module that needs them, on purpose: a module that imported them from another could not be deleted alone ([ADR-0004](0004-independent-modules.md)). ADR-0008's fifth requirement makes that repetition safe only if "both sides are tested against the same cases".

By v1.0.0 the rules existed in six modules, and the requirement held for none of them completely:

- Only the three HTTP services were checked against shared cases. The MCP server, the web app and the library each carried a hand-written table that nothing compared with anything, although ADR-0007 said the MCP server was tested against the same cases.
- Every contract case that named a task was sent one in `todo`. So the contract checked the three pairs of statuses out of `todo`, and none of the six out of `in_progress` or `done`: a service that let a finished task reopen passed.
- The contract was a list of cases a script understood. A client, or a tool that generates one, had nothing to read.
- The services logged differently: Go logged no requests, TypeScript only failures, Python the standard library server's text. A request could not be followed from a client's report to a log line.

ADR-0005 also listed the layer check of only two services, though every module now has one.

## Decision

- `scripts/rules/task-rules.json` is the one statement of the task rules.
  - The task services are held to it through the contract: a case may list `setup` requests that stage its task, the contract states all nine pairs of statuses, and a test derives the pairs from the rules file and fails when one is missing or disagrees.
  - The modules that repeat the rules without serving HTTP each print their own table with `npm run rules`, and `scripts/check-rules.mjs` compares it with the file. No module imports across its directory; the chassis asks each one, as `check-contract.mjs` already starts each service.
- `scripts/contract/openapi.json` describes the task API in OpenAPI 3.1, for clients and tools. It is held to the cases both ways by `checkSpec`: every case sent to a documented operation answers with a documented status, every documented response is exercised by a case, a method a documented path does not list is answered 405, and the schemas state the services' task fields and the rules file's statuses and title length.
- The contract also covers what a service tells its operator. Every response carries an `X-Request-Id`, echoing a usable one the caller sent and replacing anything else, and every request is logged once to stdout as one JSON line (`time`, `level`, `msg`, `method`, `path` without its query string, `status`, `durationMs`, `requestId`). The contract check reads the service's stdout and holds each line to the response it describes.

<!-- ultra:begin go-service|ts-service|py-service|mcp-server|web -->
Every module's layer rule is checked in its own toolchain, as ADR-0005 decided for the first two:
<!-- ultra:end go-service|ts-service|py-service|mcp-server|web -->

<!-- ultra:begin go-service -->
- `services/api-go`: `internal/architecture_test.go`, with `go/parser`.
<!-- ultra:end go-service -->
<!-- ultra:begin ts-service -->
- `services/api-ts`: `scripts/check-boundaries.mjs`, an allowlist per layer.
<!-- ultra:end ts-service -->
<!-- ultra:begin py-service -->
- `services/api-py`: `scripts/check_boundaries.py`, with `ast` and an allowlist of pure standard-library modules for the domain (ADR-0008).
<!-- ultra:end py-service -->
<!-- ultra:begin mcp-server -->
- `services/mcp-server`: `scripts/check-boundaries.mjs`, the same allowlists as api-ts.
<!-- ultra:end mcp-server -->
<!-- ultra:begin web -->
- `apps/web`: `scripts/check-boundaries.mjs`, which keeps features apart and `src/app` behind each feature's `index.ts`.
<!-- ultra:end web -->

## Alternatives considered

- **Generate each module's table from the rules file** — no copy could drift, but every module would gain a build step, and one that reads a file outside its directory, which is the import across modules ADR-0004 rules out.
- **A shared rules package that every module depends on** — the same coupling, published: a module could no longer be kept alone without it.
- **Make the OpenAPI document the source and generate the cases from it** — OpenAPI states shapes, not behaviour. That a title is trimmed before it is counted, or that staying put is a refused move, is a case, not a schema.
- **Leave logging to each service** — the difference was invisible until someone needed to follow a request, which is when it is most expensive to find.

## Consequences

- A rule changes in one file first, and every module that disagrees fails its own job with the key that differs.
- The contract takes a few more requests per service, and reads stdout, so a service that prints anything but JSON lines there fails.
- A new module that repeats the rules must also provide a `rules` script and join `scripts/check-rules.mjs`, or its copy is one nothing checks.
- Request ids and log lines are now behaviour: a project that changes them changes the contract first, like any other response.
