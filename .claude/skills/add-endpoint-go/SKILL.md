---
name: add-endpoint-go
description: Add or change an HTTP endpoint in services/api-go across its Clean Architecture layers, with tests at each layer. Use when a task needs a new route, request field, domain rule or status code in the Go service.
---

# Add an endpoint to api-go

Work from the inside out, one layer at a time, and run `go test ./...` in `services/api-go` after each step.

1. **Entity** (`internal/entity`) — add the rule, and a sentinel error if the operation can fail on domain grounds. No I/O and no clock: time and ids arrive as arguments. Add table-test cases to `task_test.go`, including the refused ones.
2. **Use case** (`internal/usecase`) — add a method on `Tasks`. If it needs storage the `TaskRepository` port does not offer, extend the port and implement it in `internal/repo/memory`, with a test there: the memory repository defines the behaviour every store must match.
3. **Transport** (`internal/controller/httpapi`) — add the method to the consumer-side `TaskService` interface and register the route in `NewRouter` with a method pattern (`"PATCH /api/tasks/{id}"`). Decode bodies with `decode`, which caps them at <!-- generated:contract limits.maxBodyBytes bytes -->1 MiB<!-- /generated --> and rejects unknown fields, and map any new domain error in `fail`. A new path, or a new method on a path, also goes in the map `NewRouter` registers `methodNotAllowed` with, so a wrong method answers 405 in JSON with an `Allow` header naming the methods the path takes. Add cases to `router_test.go` for success and every refusal.
4. **Wiring** — only `internal/app` chooses implementations. Change it only when a new port needs one.
5. **Check** — `node scripts/verify.mjs go-service` runs the checks the module's `module.json` lists, then the contract. If `internal/architecture_test.go` fails, a layer imported something it must not: move the code, do not widen the rule.
6. **Keep the contract in step** — every task service in this repository answers every route with the same status codes, so the endpoint starts in the contract, not here: follow the `change-task-contract` skill, which adds its cases to `scripts/contract/tasks-api.json` and its operation to `scripts/contract/openapi.json` first. Then `node scripts/generate-docs.mjs` rewrites the API table in every service's README (never edit a generated block by hand: check-docs fails it), and `scripts/check-contract.mjs` holds each service present to the new cases, so make the same change in each. If the endpoint changes who depends on whom, update `architecture/model/system.c4` when it exists.
