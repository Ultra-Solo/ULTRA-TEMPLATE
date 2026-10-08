# ADR-0031: Track the Node LTS line

**Status:** Accepted · **Date:** 2026-10-08

## Context

The template has pinned Node 24 since its first release; `.node-version` has had one commit ever. Node 24 leaves Active support on 2026-10-20 (end of life 2028-04-30). Node 26 was released 2026-05-05, is at 26.11.1, and enters Active LTS on 2026-10-28.

A generated project inherits the pinned Node, so every project initialized on the current template starts on a line about to leave Active support. The pin is the declaration every copy agrees with ([ADR-0013](0013-declare-each-fact-once.md)): `engines` in each `package.json`, the `@types/node` major, the `node:` tag in each Node Dockerfile, and the Dev Container feature, all held to it by `check-hygiene` rule 17.

Nothing in the template blocks the move. The generated code uses only public stable APIs (`node:http`, `randomUUID`, `node:stream/promises`, `node:test`); none of Node 26's removals (`_stream_*` internals, `http.Server.prototype.writeHeader`, `--experimental-transform-types`) touches it; the Node modules run `.ts` directly with erasable syntax and no transform flags; and there are no native addons, so the `NODE_MODULE_VERSION` jump to 147 is invisible. `--experimental-test-coverage`, which the coverage scripts pass, works unchanged on 26.11.1.

The owner chose 2026-10-08, ahead of the October 28 promotion: the line is mature at 26.11.1, and the promotion is a support badge, not a runtime change.

## Decision

The template runs one Node major at a time: the major the LTS line is entering, declared in `.node-version`, moved in one release together with every copy rule 17 names, with `verify` run on the new major proving the whole gate. This release moves 24 → 26.

## Alternatives considered

- **Stay on 24 until its end of life in 2028** — every project generated in the meantime would start on a line out of Active support, and the longer the gap, the more majors a single move would have to span.
- **Wait for the October 28 promotion** — the original plan; the owner chose not to wait, since the line is mature and the date is a badge, not a runtime change.
- **Track the Current line** — a six-month support window would make the gate chase a moving target and move the pin several times a year.
- **Float `>=24` ranges instead of pinning** — verify could no longer prove one runtime ([ADR-0011](0011-what-local-verify-guarantees.md)), and a range is a copy that can drift from the declaration.

## Consequences

- Every generated project and every CI run moves to Node 26 together, in one release.
- Projects generated before this release keep Node 24 until they regenerate: the pin is copied into the project, not fetched at run time.
- `@types/node` moves in lockstep, so type checking tracks the runtime actually pinned.
- An adopter whose custom code uses an API Node 26 removed must adapt on regeneration; none of the generated code does.
- The next move, when Node 28's window opens, repeats this procedure: change the declaration, every copy the check names, and prove it with verify on the new major.
