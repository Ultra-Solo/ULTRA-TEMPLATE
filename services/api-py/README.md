# api-py

The task API in Python: the same routes, the same status codes and the same configuration as `api-go` and `api-ts`, built from the same layers. Standard library only — no runtime dependencies.

`src/api_py/domain` holds the rules and is pure: no I/O, no clock, no randomness, and no imports beyond a few standard-library modules that are themselves pure. `src/api_py/application` holds the use cases and the ports they need, declared as `Protocol` classes so an adapter satisfies one by shape without importing it. `src/api_py/adapters` holds the HTTP transport and the in-memory store. `src/api_py/main.py` is the composition root and the only module that reads the environment, the clock or a random source.

`scripts/check_boundaries.py` enforces that with Python's own parser: a file in no layer fails, and so does a layer importing past its allowlist.

## Run it

```bash
uv sync --locked
uv run --directory src python -m api_py.main
```

The transport is a plain WSGI application, so production is a deployment choice rather than a dependency: `uv run gunicorn --pythonpath src 'api_py.main:app'`, waitress on Windows, or anything else that speaks WSGI. The standard-library server above enforces an absolute header deadline of <!-- generated:contract limits.receiveTimeoutsMs.headers -->5000<!-- /generated --> ms and complete-request deadline of <!-- generated:contract limits.receiveTimeoutsMs.request -->15000<!-- /generated --> ms. Production WSGI servers must be configured to enforce equivalent receive deadlines; the response to a timed-out request is server-specific.

<!-- generated:config-table -->
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | The TCP port it listens on, from 1 to 65535, in the digits 0 to 9 as Go's strconv.Atoi reads them |
| `SHUTDOWN_TIMEOUT` | `10s` | How long requests in flight may finish after SIGTERM or SIGINT, in Go's duration syntax, such as 1m30s, .5s or 500ms |
<!-- /generated -->

A value it cannot use stops the process with exit code 2 rather than falling back to a default.

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

One difference worth knowing: WSGI decodes `PATH_INFO` before a route sees it, so an id containing a percent-encoded slash only round-trips under a server that also exposes the raw target (gunicorn's `RAW_URI`), and the standard-library server collapses `//` at the start of a path before the application sees it. Generated ids never contain a slash, and non-canonical paths are outside the contract for every service.

## Check

<!-- generated:checks services/api-py -->
```bash
uv lock --check
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mypy
uv run --frozen pytest
uv run --frozen python scripts/check_boundaries.py
```
<!-- /generated -->

`node scripts/verify.mjs py-service` runs these, then the contract; CI runs the same. `uv lock --check` comes first and the rest run `--frozen`, so a `uv.lock` that no longer matches `pyproject.toml` fails instead of being rewritten. uv's own version is pinned once, in `scripts/tools/tools.json`; `[tool.uv] required-version` is the range this project accepts, and check-hygiene holds the pin inside it.

To add a store, write a class with the `TaskRepository` shape in `src/api_py/adapters` and choose it in `main.py`. Its test passes a function that returns a fresh, empty store to `check_task_repository` from `tests/task_repository_conformance.py` and expects no problems, as `tests/test_memory_task_repository.py` does: that suite is the behaviour the service relies on from a store. Its `replace` stores a task only while the stored one is still the task the caller read, which in a database is one conditional `UPDATE … WHERE` the old values: it is what keeps two moves at once from both being made ([ADR-0019](../../docs/adr/0019-moves-are-compare-and-set-on-the-store.md)).

## Container

<!-- generated:fill
```bash
docker build --tag api-py .
docker run --rm -p {{contract config.PORT.default.value}}:{{contract config.PORT.default.value}} api-py
```
-->
```bash
docker build --tag api-py .
docker run --rm -p 8080:8080 api-py
```
<!-- /generated -->

The image applies the vendor fixes in [security-packages.json](security-packages.json) using [the build installer](scripts/install_security_packages.py). Its versions and per-architecture SHA-256 checksums identify exact payloads; the build never selects packages from changing apt indexes. Every checksum and package identity is checked before installation, and installed versions are checked afterward. A newer pinned base is never downgraded. `py-image-security` feeds the required verify gate on native amd64 and arm64, exercises every HTTP case and receive deadline with `node scripts/probe-image.mjs py-service --full-contract`, retains full scan artifacts, and rejects fixable high/critical findings. Lower-severity or unfixed findings remain visible.

Update this bounded patch by reviewing Debian vendor advisories and obtaining package paths/checksums from signed security indexes verified with Debian's archive keyring. Download and inspect package name, version and architecture for every supported lock entry; do not infer checksums or disable TLS. Run the package-lock tests, build and scan the final image, and compare its complete report with the baseline against one database snapshot. Verify the native application checks before committing a lock refresh. When a verified fixed upstream base makes the patch redundant, remove it in the base-update PR. Missing pool files fail the build; they require a reviewed refresh or fixed base rather than an unchecked fallback.

Behind a managed HTTPS proxy, pass a public combined CA bundle with `docker build --secret id=proxy_ca,src=/path/to/public-ca-bundle.pem --tag api-py .`. The optional secret is used during download and is not copied into image layers. Normal builds need no secret. Input bytes are reproducible; timestamped package/image metadata need not be identical across builds. See [ADR-0024](../../docs/adr/0024-lock-runtime-security-payloads.md).
