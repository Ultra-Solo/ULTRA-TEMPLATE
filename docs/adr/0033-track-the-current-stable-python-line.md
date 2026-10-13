# ADR-0033: Track the current stable Python line

**Status:** Accepted · **Date:** 2026-10-13

## Context

The template pinned Python 3.14 while 3.15.0 final was released 2026-10-09, and nothing forced a move: 3.14 keeps its bugfixes until around October 2027 and its security fixes until its end of life in 2030-10. No policy said which Python line the template tracks — the same gap [ADR-0031](0031-track-the-node-lts-line.md) and [ADR-0032](0032-track-the-current-stable-go-line.md) closed for Node and Go — and a generated project inherits the pin, so a stale template starts every project behind.

The move's gates are the ecosystem, not the code. The Dockerfile's `FROM python:…-slim` needs the image on Docker Hub, and every py-service check is `uv run --frozen`, so the pinned uv must know the new final — CI installs uv from `scripts/tools/tools.json` ([ADR-0017](0017-prove-the-supply-chain-before-it-runs.md)), and uv 0.13.0 is the first release that knows 3.15.0. The pin and the `required-version` range in `pyproject.toml` move together, or uv refuses to run the module at all. Nothing else blocks: ruff, mypy, pytest and the boundary check ran green on 3.15.0 final under uv 0.13.0 before the move, `uv lock --check` passes under 0.13.0 without regenerating the lock, and the locked security payloads need no change (deb13u3 is still the only version in the trixie-security pool).

## Decision

The template runs the current stable Python minor, declared in `services/api-py/.python-version`, moved in one release together with every copy rule 17 names — the `python:` tag and digest in the service's Dockerfile, the Dev Container python feature — and in the same release the uv pin and the `required-version` range that admits it, once the Docker Hub image and a uv that knows the final both exist. This release moves 3.14 → 3.15 and uv 0.12.24 → 0.13.0.

## Alternatives considered

- **Move only when 3.14 approaches the end of its bugfix window (~October 2027)** — every project generated in the meantime starts a year behind, and the drift goes unnoticed without a policy.
- **Wait for 3.15.1 (~2026-12)** — the same staleness for two more months; the module's checks already pass on the final.
- **Move on the release candidate** — an RC is not a release: the image tags and uv's knowledge would be wrong for a generated project.
- **Split the move (interpreter now, image later)** — rule 17 fails a declaration whose copies disagree, by design ([ADR-0013](0013-declare-each-fact-once.md)).

## Consequences

- A Python move roughly every year — minors land each October — each one a small release: the declaration, its copies, the uv pin, verify on the new minor.
- The ecosystem gates each move: the Docker Hub image and uv's knowledge of the final can lag the source release by days, so a move waits for both.
- The uv pin and the `required-version` range move together; rule 17 holds the pin inside the range, and a uv that changes the lock format is caught by `uv lock --check` under the new pin before the move.
- Projects generated before this release keep Python 3.14 until they regenerate: the pin is copied into the project, not fetched at run time.
