---
name: add-endpoint-ts
description: Add or change an HTTP endpoint in services/api-ts across its domain, application and adapter layers, with tests at each layer. Use when a task needs a new route, request field, domain rule or status code in the TypeScript service.
---

# Add an endpoint to api-ts

Work from the inside out and run `npm test` in `services/api-ts` after each step.

1. **Domain** (`src/domain`) — add the rule as a pure function over plain data. Throw a `DomainError` with a new code if the operation can fail on domain grounds. No `node:` imports and no packages: ids and timestamps arrive as arguments. Test it in `test/domain.test.ts`, including the refused cases.
2. **Application** (`src/application`) — add a method on `TaskService`. If it needs storage the `TaskRepository` port does not offer, extend the port in `ports.ts` and implement it in `src/adapters/memory-task-repository.ts`.
3. **Adapter** (`src/adapters/http.ts`) — add the route in `route`. Read bodies with `readObject`, passing the fields the endpoint accepts, and map any new `DomainError` code in `STATUS_BY_CODE`; the `satisfies` clause fails type-checking until every code has a status. Add cases to `test/http.test.ts` for success and every refusal.
4. **Composition root** — only `src/main.ts` chooses adapters.
5. **Check** — `node scripts/verify.mjs ts-service` runs `npm run verify` (lint, the import-boundary check, the type-checker and the tests), then the contract. If the boundary check fails, a layer imported something outside its allowlist: move the code, do not widen the allowlist. Use only syntax Node can strip: no `enum`, `namespace` or constructor parameter properties.
6. **Keep the contract in step** — every task service in this repository answers every route with the same status codes, so the endpoint starts in the contract, not here: follow the `change-task-contract` skill, which adds its cases to `scripts/contract/tasks-api.json` and its operation to `scripts/contract/openapi.json` first. Then `node scripts/generate-docs.mjs` rewrites the API table in every service's README (never edit a generated block by hand: check-docs fails it), and `scripts/check-contract.mjs` holds each service present to the new cases, so make the same change in each. If the endpoint changes who depends on whom, update `architecture/model/system.c4` when it exists.
