# api-go

A task HTTP service in Go, organised in Clean Architecture layers and built on the standard library alone.

```text
cmd/api/                  entry point: configuration, signals, listener
internal/entity/          domain model and rules — no I/O, imports nothing from this module
internal/usecase/         application logic and the ports it needs (TaskRepository)
internal/repo/memory/     a TaskRepository kept in memory
internal/controller/httpapi/  HTTP transport: decode, call a use case, map errors to status codes
internal/config/          environment configuration, validated at startup
internal/app/             composition root: the only place concrete implementations are chosen
```

Dependencies point inwards. `internal/architecture_test.go` parses every production file and fails `go test` when a layer imports something it must not, so the rule holds without a linter and without review catching it.

## Run

<!-- generated:fill
```bash
go run ./cmd/api
curl -s localhost:{{contract config.PORT.default.value}}/api/tasks -d '{"title":"ship it"}'
```
-->
```bash
go run ./cmd/api
curl -s localhost:8080/api/tasks -d '{"title":"ship it"}'
```
<!-- /generated -->

<!-- generated:config-table -->
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | The TCP port it listens on, from 1 to 65535, in the digits 0 to 9 as Go's strconv.Atoi reads them |
| `SHUTDOWN_TIMEOUT` | `10s` | How long requests in flight may finish after SIGTERM or SIGINT, in Go's duration syntax, such as 1m30s, .5s or 500ms |
<!-- /generated -->

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

Bodies are capped at <!-- generated:contract limits.maxBodyBytes bytes -->1 MiB<!-- /generated --> and unknown fields are rejected with `400`. `HEAD` is answered wherever `GET` is. A missing or `null` title reads as empty (`422`); a title of another type, an empty body and a malformed path are refused as malformed (`400`). Every error is JSON, `{"error": "…"}`. The cases in [`scripts/contract/tasks-api.json`](../../scripts/contract/tasks-api.json) are the contract every task service keeps, and `node scripts/check-contract.mjs` holds this one to them.

Every response carries an `X-Request-Id`: the one the caller sent when it is 1 to <!-- generated:contract limits.requestId.maxLength -->128<!-- /generated --> letters, digits, `.`, `_` or `-`, otherwise a new one. Every request is logged once to stdout as one JSON line holding `time`, `level`, `msg` (`"request"`), `method`, `path` (without the query string, which can carry what should not be logged), `status`, `durationMs` and `requestId`. The line is the same in every task service, and the contract check reads it. [`scripts/contract/openapi.json`](../../scripts/contract/openapi.json) describes the same API for clients and tools, and is held to the same cases.

## Check

<!-- generated:checks services/api-go -->
```bash
gofmt -l .
go mod tidy -diff
go vet ./...
go test -race ./...
golangci-lint run
```
<!-- /generated -->

`node scripts/verify.mjs go-service` runs these, then the contract; CI runs the same. The image:

```bash
docker build -t api-go .
```

To add a store, implement `usecase.TaskRepository` in a new package under `internal/repo/` and choose it in `internal/app`. Its tests call `repotest.Run` with a function that returns a fresh, empty store, as the memory store's tests do: `internal/repo/repotest` is the behaviour the service relies on from a store, and passing it is what makes the new one a replacement rather than a rewrite.
