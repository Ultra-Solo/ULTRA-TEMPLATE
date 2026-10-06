# ADR-0028: Run the browser smoke test through the e2e slot

**Status:** Accepted · Amends [ADR-0027](0027-ship-run-and-diagnose-before-the-browser-smoke-test.md) · **Date:** 2026-10-05

## Context

[ADR-0027](0027-ship-run-and-diagnose-before-the-browser-smoke-test.md) moved B2 — the real browser-to-API smoke test [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) defines as "Chromium, TypeScript API + web; create/change/reload task journey; controlled API error and keyboard interaction; isolated data, unique ports, traces on failure" — to v3.6.0, and left its harness to this release's investigation: "Whether its harness builds on the dev runner or starts its own stack the way `check-contract --e2e` does is decided in that release's investigation, not now." ADR-0027 also called B2 "the only item that changes the CI topology" and worried that a flake there lands inside the required `verify` gate that publication waits on.

The investigation found the harness already built, and the topology change smaller than feared:

- The `module.json` schema has carried an `e2e` key since [ADR-0014](0014-modules-describe-themselves.md): `{"run": [command, …]}` with `{taskApi}` standing for the service URL. `scripts/check-contract.mjs --e2e <client> --service <service>` starts a task service on a free port with scratch data, substitutes `{taskApi}`, runs the client's command, and stops the service. `scripts/verify.mjs` runs it for every module that declares the key, and skips it with a message when no task service is present. `e2ePartner` picks the service on the client's own toolchain — ts-service for web, exactly ADR-0025's "TypeScript API + web" — and the CI module action already installs the partner in the client's job. The `mcp-server` module has ridden this slot since v3.4.0 (`scripts/drive.ts`), so the client-side convention exists too: a plain script, exit 0 when the journey passes, 1 when it fails, 2 when it could not run.
- So B2 needs **no new CI job and no workflow edit**: the web job gains the smoke step from its manifest, the way every other check in `module.json` already reaches CI. What ADR-0027 expected to be a topology change is a manifest entry.
- The flake worry remains real, and shapes the choices below: the browser must be the same binary everywhere, the service must be real and isolated, and a failure must leave something to look at.

## Decision

- **B2 rides the e2e slot.** `apps/web/module.json` gains `"e2e": {"run": ["npm", "run", "--silent", "e2e", "--", "{taskApi}"]}`, and `check-contract --e2e web --service ts-service` — run by `verify.mjs`, in CI and locally alike — is the whole harness. No bespoke harness script, no dev-runner involvement, no CI workflow change.
- **The client command is a plain script**, `apps/web/scripts/e2e.ts`, following the `drive.ts` convention: exit 0 when the journey passes, 1 when an assertion fails, 2 when the smoke could not run (no browser, no server). No retries, no hidden re-runs — a flake shows up as a flake.
- **Playwright the library, not `@playwright/test`.** `playwright` becomes an `apps/web` devDependency (it has no postinstall script, so `--ignore-scripts` installs stay safe); the script drives Chromium through the library API. The `@playwright/test` runner's retry and reporting machinery fights the exit-code convention above.
- **Playwright-pinned Chromium, installed by the script.** The script runs `playwright install chromium` first — a fast no-op when present — so the same pinned binary runs locally and in CI. Runner-image Chrome is rejected: it drifts with the image, which is a flake source, not a stability property.
- **The production build, served by `vite preview`.** The script runs `vite build`, then `vite preview` on a free port. Vite's preview server inherits `server.proxy`, so the `/api` proxy needs no second declaration, and the journey exercises the app as shipped. The proxy target comes from the `{taskApi}` URL the script receives, passed to Vite through an environment variable read in `vite.config.ts`, defaulting to the port the `apiDefaultPort` fact already states.
- **The journey** [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) names: create a task by keyboard (fill the title, press Enter), see it appear; move it by click, see the status label change; reload the page, see it persist; then a controlled API error — a title past the contract's limit, answered by the real service with a real 422 — surfaced in the app's `role="alert"` region. A Playwright trace is saved and its path printed when any step fails.

## Alternatives considered

- **Build the harness on the dev runner** — Rejected: the runner is for humans — it watches, it stays up, it serves the developer's stack. A CI harness needs start/stop, scratch data and a free port, which `check-contract --e2e` already owns.
- **A bespoke harness script** — Rejected: it would duplicate the service lifecycle the e2e slot already has, and need new CI wiring — the topology change ADR-0027 wanted to avoid, for no capability the slot lacks.
- **`@playwright/test`** — Rejected: its runner retries by default and reports through its own exit path; the repository's checks are plain commands with honest exit codes, and `drive.ts` set that convention for this slot.
- **Runner-image Chrome (`channel: "chrome"`)** — Rejected: the image changes under the job; Playwright-pinned Chromium is byte-identical on every machine that runs the same lockfile.
- **The dev server instead of `vite preview`** — Rejected: preview serves the built app, so the smoke proves what ships; the dev server would prove the dev experience, which the dev runner already covers.
- **`actions/cache` for the browser download** — Rejected for now: that action is not pinned in this repository, so adding it means new supply-chain surface for a ~130 MB download the CI job already tolerates. Measure the cost first; add a cache only if the download proves expensive.

## Consequences

- **Easier**: B2 lands with zero CI topology change — the web job gains the smoke from its manifest, like every other check; generated projects inherit the same proof through the web feature's files, and `verify.mjs` skips it with a message when no task service is present; the harness is one script and one manifest key, tested by the same `check-contract` path CI already runs.
- **Harder, or costs**: `apps/web` gains a Playwright devDependency and a one-time Chromium download (~130 MB) per machine; the web job takes a browser install, a build and a preview server on top of its current checks; and a browser in the required gate can still flake — pinned Chromium, free ports, scratch data and traces make flakes rare and diagnosable, not impossible, which is the trade ADR-0025 accepted when it kept B2 on the list.
