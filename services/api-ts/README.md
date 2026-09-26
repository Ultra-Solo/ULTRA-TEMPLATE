# api-ts

The task HTTP service in TypeScript, with the same API, status codes and configuration as `api-go`. Node runs the `.ts` sources directly, so there is no build step and no runtime dependency.

```text
src/domain/        pure rules over plain data — no I/O, clock, randomness or packages
src/application/   use cases, and the ports they need (TaskRepository, Clock, IdGenerator)
src/adapters/      HTTP transport and the in-memory repository
src/config.ts      environment configuration, validated at startup
src/main.ts        composition root: the only place concrete adapters are chosen
```

`scripts/check-boundaries.mjs` enforces the direction of those dependencies over every file with an allowlist per layer, and its tests prove each rule can fire.

## Run

<!-- generated:fill
```bash
npm install
npm start
curl -s localhost:{{contract config.PORT.default.value}}/api/tasks -d '{"title":"ship it"}'
```
-->
```bash
npm install
npm start
curl -s localhost:8080/api/tasks -d '{"title":"ship it"}'
```
<!-- /generated -->

<!-- generated:config-table -->
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | The TCP port it listens on, from 1 to 65535, in the digits 0 to 9 as Go's strconv.Atoi reads them |
| `SHUTDOWN_TIMEOUT` | `10s` | How long requests in flight may finish after SIGTERM or SIGINT, in Go's duration syntax, such as 1m30s, .5s or 500ms |
<!-- /generated -->

The same variables, read by the same rules, configure every task service in this project.

## API

<!-- generated:api-table -->
| Method and path | Answers |
|---|---|
| `GET /healthz` | `200` The service is up |
| `GET /api/tasks` | `200` Every task |
| `POST /api/tasks` `{"title"}` | `201` The task, created · `400` The body is not one UTF-8 JSON object of the documented fields, spelled exactly and of the documented types, or is over the size limit · `422` The title is empty once trimmed, or longer than the rules allow |
| `GET /api/tasks/{id}` | `200` The task · `400` The id is not a valid path segment, such as a malformed percent-escape · `404` No task has this id |
| `PATCH /api/tasks/{id}/status` `{"status"}` | `200` The task, moved · `400` The body is not one UTF-8 JSON object of the documented fields, spelled exactly and of the documented types, or is over the size limit · `404` No task has this id · `409` The rules do not allow this move from the task's status, staying put included · `422` The status is missing, null, or not one of the statuses |
<!-- /generated -->

Bodies are capped at <!-- generated:contract limits.maxBodyBytes bytes -->1 MiB<!-- /generated --> and unknown fields are rejected with `400`. `HEAD` is answered wherever `GET` is. A missing or `null` title reads as empty (`422`); a title of another type, an empty body and a malformed path are refused as malformed (`400`). Every error is JSON, `{"error": "…"}`. The cases in [`scripts/contract/tasks-api.json`](../../scripts/contract/tasks-api.json) are the contract every task service keeps, and `node scripts/check-contract.mjs` holds this one to them. This module keeps its own copy of the table so it stays readable, and removable, on its own.

Every response carries an `X-Request-Id`: the one the caller sent when it is 1 to <!-- generated:contract limits.requestId.maxLength -->128<!-- /generated --> letters, digits, `.`, `_` or `-`, otherwise a new one. Every request is logged once to stdout as one JSON line holding `time`, `level`, `msg` (`"request"`), `method`, `path` (without the query string, which can carry what should not be logged), `status`, `durationMs` and `requestId`. The line is the same in every task service, and the contract check reads it. [`scripts/contract/openapi.json`](../../scripts/contract/openapi.json) describes the same API for clients and tools, and is held to the same cases.

## Check

<!-- generated:checks services/api-ts -->
```bash
npm run verify   # lint, check:boundaries, typecheck, test
```
<!-- /generated -->

`node scripts/verify.mjs ts-service` runs it, then the contract; CI runs the same. The image:

```bash
docker build -t api-ts .
```

`tsc` only type-checks. Keep to syntax Node can strip (`erasableSyntaxOnly` enforces it): no `enum`, no `namespace`, no constructor parameter properties.

To add a store, implement `TaskRepository` (`src/application/ports.ts`) in an adapter and choose it in `src/main.ts`. Its test passes a function that returns a fresh, empty store to `checkTaskRepository` from `test/task-repository-conformance.ts` and expects no problems, as `test/memory-task-repository.test.ts` does: that suite is the behaviour the service relies on from a store. Its `replace` stores a task only while the stored one is still the task the caller read, which in a database is one conditional `UPDATE … WHERE` the old values: it is what keeps two moves at once from both being made ([ADR-0019](../../docs/adr/0019-moves-are-compare-and-set-on-the-store.md)).
