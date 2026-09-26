# web

A React single-page app on Vite that lists tasks and moves them through their lifecycle, organised the way bulletproof-react recommends: by feature, with imports flowing one way.

```text
src/lib/                 shared code: the HTTP helper. Imports nothing from a feature or the app.
src/features/tasks/      one feature: api.ts (requests), model.ts (types, rules, response validation),
                         components/, and index.ts — the only file the app may import
src/app/                 composition: layout and which features appear
src/main.tsx             entry point
```

`scripts/check-boundaries.mjs` fails the build when a feature imports another feature or the app, when shared code imports a feature, or when the app reaches past a feature's `index.ts`. A new capability is a new folder under `src/features/`.

## Run

<!-- generated:fill
```bash
npm install
npm run dev        # http://localhost:5173, with /api proxied to :{{contract config.PORT.default.value}}
```
-->
```bash
npm install
npm run dev        # http://localhost:5173, with /api proxied to :8080
```
<!-- /generated -->

Start one of this project's task services on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated --> for the page to have data; the service's own README says how.

## Check

<!-- generated:checks apps/web -->
```bash
npm run verify   # lint, check:boundaries, typecheck, test, build
```
<!-- /generated -->

## Test

- **Unit** — `model.test.ts` and `lib/http.test.ts` test rules and the HTTP helper as plain functions.
- **Component** — `components/task-board.test.tsx` renders the board with Testing Library in happy-dom, with `fetch` stubbed, and checks what a user sees and can do.

`model.ts` validates every API response before a component sees it, and mirrors the services' transition rules so the interface offers only moves the API accepts. `npm run build` writes a static site to `dist/`, which any static host can serve.
