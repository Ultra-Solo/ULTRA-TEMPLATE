# ADR-0008: Add a third language, and state what any module must prove

**Status:** Accepted · Amended by [ADR-0010](0010-one-statement-of-the-task-rules.md) and [ADR-0014](0014-modules-describe-themselves.md) · **Date:** 2026-09-18

## Context

The architecture here is meant to be language-independent: dependencies point inward, the domain is pure, adapters are replaceable, and the layer rule is enforced by a check rather than by review. Go and TypeScript alone would not show it, because they share more than they look like they do: both are statically typed, both build to a single artifact, both install from a lockfile the other modules already know how to drive.

A claim proved twice inside one habitat is a weaker claim than it appears. Much of the work a project like this serves is written in Python, and Python breaks several of those implicit assumptions: there is no compiler to fail the build, its packaging has changed repeatedly, and its usual web frameworks pull in a dependency tree before the first line of domain code is written.

Python's tooling has also stopped being contested. `uv` resolves and installs from a lockfile, ruff lints and formats, mypy type-checks, pytest runs the tests — the same four jobs the other two modules already do, under different names.

## Decision

- Add `services/api-py`: the same task API, the same routes, the same status codes, and the same environment variables — including Go's duration syntax for `SHUTDOWN_TIMEOUT` — as `api-go` and `api-ts`.
- It depends on nothing at runtime. The transport is a WSGI application, so the development server is the standard library's and production is a deployment choice (gunicorn, waitress, anything) rather than a dependency chosen here for every project.
- Its layer rule is enforced in its own toolchain: `scripts/check_boundaries.py` reads every module with `ast` and fails when a layer imports past its allowlist, as `internal/architecture_test.go` does with `go/parser` and `scripts/check-boundaries.mjs` does for TypeScript.
- The domain's allowlist is a set of *pure* standard-library modules. `os`, `time`, `random`, `json` and `threading` are effects and belong to an adapter or the composition root.
- `uv` is the toolchain and `uv.lock` is committed. `uv sync --locked` is what both `scripts/setup.mjs` and CI run: it installs exactly what the lockfile pins and refuses a lockfile that no longer matches `pyproject.toml`. The service runs from `src/` and is never built as a package, so no build backend is fetched and run at install time.

This fixes what a module has to prove, whatever its language:

1. It installs from a committed lockfile, with one command.
2. It has one entry point that runs every check it owns, and CI runs that same entry point.
3. Its layer rule is machine-checked in its own toolchain, with a test that proves the check can fail.
4. It is removable: deleting the directory removes it from `setup`, `verify` and the gate with nothing else to edit.
5. Where it restates behaviour another module already implements, the behaviour is identical and both sides are tested against the same cases.

## Alternatives considered

- **FastAPI or Flask** — what most Python services actually use, and a dependency tree plus a framework opinion imposed on every project. The domain and use cases are untouched by that choice; swapping the adapter is the exercise a project does on day one.
- **A Python library instead of a service** — would exercise packaging and PyPI trusted publishing, but not the architecture. `ts-library` already covers publishing; a second one would have shown less.
- **`poetry` or `pip-tools`** — both work; `uv` installs from the lockfile fastest, and resolves the interpreter itself, so CI needs no separate Python setup step.
- **Leaving the claim at two languages** — cheaper, and leaves "language-independent" resting on two members of the same family.

## Consequences

- The status rules and the duration grammar now exist in four modules (three services and the MCP server). That repetition is deliberate ([ADR-0004](0004-independent-modules.md)) and bounded by rule 5 above: identical behaviour, tested against the same cases.
- CI gains a job with a toolchain the other jobs do not share, and contributors to that module need `uv`. `verify` reports a missing toolchain as a failure rather than skipping it.
- A project that wants a framework replaces one adapter; nothing in the domain or the use cases changes. That is the claim this module exists to make checkable.
- The stdlib WSGI server is a development server. The README says so, and says what to run instead.
