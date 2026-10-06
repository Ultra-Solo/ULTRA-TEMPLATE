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
npm ci --ignore-scripts
npm run dev        # http://localhost:5173, with /api proxied to :{{contract config.PORT.default.value}}
```
-->
```bash
npm ci --ignore-scripts
npm run dev        # http://localhost:5173, with /api proxied to :8080
```
<!-- /generated -->

Start one of this project's task services on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated --> for the page to have data; the service's own README says how. From the repository root, `node scripts/dev.mjs` starts this app and a task service together.

## Check

<!-- generated:checks apps/web -->
```bash
npm run verify   # lint, check:boundaries, typecheck, test, build
```
<!-- /generated -->

## Test

- **Unit** — `model.test.ts` and `lib/http.test.ts` test rules and the HTTP helper as plain functions.
- **Component** — `components/task-board.test.tsx` renders the board with Testing Library in happy-dom, with `fetch` stubbed, and checks what a user sees and can do.
- **Browser smoke** — `scripts/e2e.ts` builds the app, serves the production bundle with `vite preview`, and drives it with a real Chromium against a running task API: create by keyboard, move by click, reload and see it persist, then a title the API refuses and the board's reason for it — where a component test's stubbed `fetch` cannot reach. A Playwright trace is written to `test-results/` when a step fails. On Linux the browser needs its OS libraries: the Dev Container's image installs them, and a bare machine that lacks one sees it named in the failure.

<!-- generated:fill
```bash
npm run e2e -- http://localhost:{{contract config.PORT.default.value}}   # the built app in Chromium against a task API
```
-->
```bash
npm run e2e -- http://localhost:8080   # the built app in Chromium against a task API
```
<!-- /generated -->

From the repository root, `node scripts/verify.mjs` runs the smoke automatically, against a task service on a free port with scratch data.

`model.ts` validates every API response before a component sees it, and mirrors the services' transition rules so the interface offers only moves the API accepts. `npm run build` writes a static site to `dist/`, which any static host can serve.
