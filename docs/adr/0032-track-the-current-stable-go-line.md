# ADR-0032: Track the current stable Go line

**Status:** Accepted · **Date:** 2026-10-09

## Context

The template pinned Go 1.26 while Go 1.27 had been out since 2026-08-19 (at 1.27.2), and nothing noticed: an October 2026 strategy note recorded "Go 1.26: current" wrongly, because no policy said which Go line the template tracks and no check compares the pin with the released line. Go supports two majors at a time, so 1.26 keeps its security fixes until Go 1.28 ships (~February 2027) — there was no forcing function, which is exactly why the staleness went unnoticed.

A generated project inherits the pin, so every project initialized since August started one major behind.

The move's gate is golangci-lint: the pinned release must support the new major before the declaration can move. golangci-lint 2.14.0 (2026-09-24) is built with go1.27.0 and lints the module clean with `go 1.27` set. Nothing else blocks: Go keeps its compatibility promise, the service uses only the standard library, and gofmt, vet (including 1.27's new printf `%w` check), tests and `go mod tidy -diff` all pass on 1.27.1 against the module before the move.

## Decision

The template runs the current stable Go major, declared in the `go` line of `services/api-go/go.mod`, moved in one release together with every copy rule 17 names — the `golang:` tag in the service's Dockerfile, the Dev Container go feature — once the pinned golangci-lint supports the new major, with `verify` proving the whole gate on it. This release moves 1.26 → 1.27.

## Alternatives considered

- **Move only when the pinned major approaches its end of support** — every project generated in the meantime starts behind, and the gap is a full major: 1.26's support ends the day 1.28 ships.
- **Skip majors (wait for 1.28)** — the same staleness for four more months, and the October note shows the drift goes unnoticed without a policy.
- **Wait for a forcing function** — there is none; Go's two-major support window means nothing breaks on the old line, which is exactly how the pin went stale.
- **Let the toolchain float (`GOTOOLCHAIN=auto`)** — verify could no longer prove one runtime, and the declaration is the fact every copy agrees with ([ADR-0013](0013-declare-each-fact-once.md)).

## Consequences

- A Go move roughly every six months — Go majors land in February and August — each one a small release: the declaration, its copies, verify on the new major.
- The pinned golangci-lint gates each move: if it lags a new Go major, the move waits for a golangci-lint release that supports it, which `pins.yml` surfaces.
- Projects generated before this release keep Go 1.26 until they regenerate: the pin is copied into the project, not fetched at run time.
- Go's compatibility promise keeps each move to toolchain declarations in practice; the release notes still read the new major's changes before moving.
