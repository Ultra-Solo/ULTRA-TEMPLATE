# ADR-0005: Layered services with enforced boundaries

**Status:** Accepted · Amended by [ADR-0010](0010-one-statement-of-the-task-rules.md) · **Date:** 2026-09-15

## Context

Services organised in layers — domain, use cases, adapters, a composition root — stay testable and replaceable only while dependencies point inward. That rule erodes one convenient import at a time, and code review notices late or not at all. Layering by convention alone is where most Clean Architecture codebases end up.

## Decision

Every service keeps four roles:

1. **Domain** — rules over plain data. No I/O, clock, randomness or framework; ids and timestamps are passed in.
2. **Use cases** — application logic, depending on the domain and on ports (interfaces) the layer declares.
3. **Adapters** — implementations of those ports and the transports that call the use cases.
4. **Composition root** — the one place concrete implementations are chosen and wired. No business logic.

The dependency rule is enforced by a test in the service's own toolchain, over every production file, and each rule has a test showing it can fail:

<!-- ultra:begin go-service -->
- `services/api-go/internal/architecture_test.go` parses every file's imports with `go/parser` and fails `go test` on a forbidden one.
<!-- ultra:end go-service -->
<!-- ultra:begin ts-service -->
- `services/api-ts/scripts/check-boundaries.mjs` gives each layer an allowlist of what it may import; `npm run verify` runs it before type-checking.
<!-- ultra:end ts-service -->

Test files are exempt: a test may wire real implementations together.

## Alternatives considered

- **Convention and review only** — the rule holds until the first deadline.
- **A linter rule such as depguard or eslint-plugin-boundaries** — works, but only where the linter is installed and configured; a test runs wherever the toolchain does, and needs no extra dependency.

## Consequences

- A forbidden import fails the build locally and in CI, with the rule it broke in the message.
- The rule is only as complete as its matcher: a dependency smuggled in as a value — a function passed down from the composition root — is invisible to an import check. Ports declared in the use-case layer keep that deliberate and visible.
