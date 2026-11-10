# ADR-0049: Narrate every runtime flow as a dynamic view

**Status:** Accepted · **Date:** 2026-11-06

## Context

`architecture/model/views.c4` held three static views — `index`, `containers of product`, `machinery` — which show what exists and what depends on what, but not what happens when the system runs. The one runtime question this repository cares most about is a task move: a client asks to move a task to another status, the service judges the move against the task rules in `scripts/rules/task-rules.json` (ADR-0010), and an illegal or lost move is refused with `409 Conflict` because the store replaces a task compare-and-set or not at all (ADR-0019). No view answered "what happens on a move, and where is an illegal move refused", so the model described the shape of the system but not its behavior, and a change that dropped the compare-and-set or the 409 fired no architecture rule.

LikeC4 dynamic views exist for exactly this: steps defined only in the view, without polluting the model, with responses in the reverse direction (`web <- api`). Nothing in `architecture/rules.mjs` held a static view to the runtime, so the gap was also invisible to the checks.

## Decision

- `architecture/model/views.c4` gains a fourth view, `dynamic view taskMove` ("Moving a task: every client, and where an illegal move is refused"): the user asks each client (`product.web`, `product.mcpServer`) or calls each task service (`product.apiGo`, `product.apiTs`, `product.apiPy`) directly; each client calls `PATCH /api/tasks/{id}/status`, the route `scripts/contract/openapi.json` declares and every service serves; the service answers `200 OK: the task moved` or `409 Conflict: the store is untouched (ADR-0019)` in the reverse direction, inside an `alt` block whose `else` names the compare-and-set. The assistant refuses an illegal move it can recognise locally before any service is called (`services/mcp-server/src/application/task-tools.ts`), so its block shows that self-call first and sends only a move the local check accepts. A `user -> product.tsLibrary` step covers the remaining runtime relationship. Every step that names a feature-owned element is wrapped in that feature's `ultra:begin`/`ultra:end` marker, and a client with its service in a *pair* marker (`web&go-service`), so a generated project keeps exactly the steps whose elements it keeps — a block marked for several features any-of stays in a project that has only one of them.
- `architecture/rules.mjs` gains the rule `runtimeFlowDocumented`: every model relationship from `user` into `product` or between two `product` elements must be a step of some dynamic view (`view.includesRelation`), with a hand-built `violating` model per ADR-0043.
- `architecture/test/model.test.mjs` needs no change: its generic meta-tests pick up the new rule and its failing case automatically.

## Alternatives considered

- **Document the move flow only in prose (AGENTS.md, ADR-0018/0019).** Rejected: prose is not checked; the model is checked in CI like any other source, and a dynamic view renders on the published site.
- **Make the static views carry it.** Rejected: static views show structure, not sequences; LikeC4 dynamic views exist for scenarios and keep steps out of the model.
- **Rule over all relationships, chassis included.** Rejected: the chassis machinery (verify, guards, the gate) is drawn for structure (ADR-0044–ADR-0048), not narrated as runtime flows; the rule scopes to the product, where behavior is a contract.
- **Scope the rule to the move flow only.** Rejected: a rule that names one scenario rots when the next flow arrives; "every product runtime relationship is narrated" is the universal statement and the move is its first instance.
- **A rule requiring every step to be backed by a declared relationship.** Rejected (ADR-0050): a response step and a self-call are legitimately unbound in LikeC4, and binding them by declaring the reverse relationship would itself violate `clientDependencies`. `interactionsAnswered` states the checkable part of that intent instead.
- **Trust `likec4 validate` to keep a view honest.** Rejected (ADR-0050): it validates a step's endpoints, not its label. A view naming a route this repository does not serve validates and passes every rule.

## Consequences

- The published architecture site (GitHub Pages, `.github/workflows/architecture.yml`) now shows the move scenario, including where a refusal happens, next to the static views.
- Adding a product element or a relationship from the user into the product without a dynamic-view step fails `npm test` in `architecture/` in the same change — the rule fires with the relationship named.
- Generated projects keep the invariant automatically: a feature marker strips a step exactly when the feature's element is removed. The view is titled for what survives in every preset that ships `architecture/` — `go-api` and `py-api` keep one step, `fullstack-ts` five, `all` twenty-seven — so the title promises no client and no refusal the project does not have.
- A step's prose is now checked against the contract, not only its endpoints (ADR-0050), so the route this view names cannot drift from `scripts/contract/openapi.json` again.
- The selection with no product is the one case where this view keeps its body and loses every step: `--features architecture` keeps the `product` system declaration (it sits outside the markers) but none of its elements, so `taskMove` survives with zero steps. That is not a defect the rules must report — nothing is narratable there — and `viewsSaySomething` therefore checks its premise before blaming an empty view (ADR-0050).

## Enforcement

`architecture/test/model.test.mjs` (`npm test` in `architecture/`, part of `npm run verify`): the test "the model satisfies every rule" fails when a product runtime relationship is not a step of any dynamic view, and the meta test "every rule ships a failing case and fires on it" fails when `runtimeFlowDocumented` loses its `violating` model. `npx likec4 validate model` fails a view whose steps name elements that do not exist; the routes the steps name are held to `scripts/contract/openapi.json` by `routesDeclared`, and a step that enters the product and is never answered fails `interactionsAnswered` (ADR-0050).
