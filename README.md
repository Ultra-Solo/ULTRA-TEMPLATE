# ULTRA-TEMPLATE

[![verify](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/actions/workflows/verify.yml/badge.svg)](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/actions/workflows/verify.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- project description -->

<!-- ultra:begin template -->
**A GitHub repository template that starts a project with the verification, supply-chain and architecture discipline most projects only add after their first incident — and lets you choose the stack.**

It is for anyone starting a service, a web app, a library or an MCP server who wants those checks in place from the first commit, not added after something breaks.

- **One gate.** `node scripts/verify.mjs` runs every module's checks as CI does, and CI reports a single required check, `verify`.
- **A pinned supply chain the build enforces.** Actions pinned to commit SHAs, checksum-verified downloads, digest-pinned images, and npm installs that run no dependency's install scripts, with every package's registry signature verified. Every hand-pinned tool is written once, with its checksum, and every copy of a toolchain version is held to the file that declares it. Every platform's pinned checksum is compared with its release on each change to a pin, a weekly report names the hand-pinned tools that have a newer release, the commits each change adds are scanned for secrets before it can merge, and the published MCP image carries a build provenance attestation.
- **Repository hygiene checks.** A tracked `.env`, a vendored `node_modules`, a truncated `.gitignore`, a file over 4 MB, a module missing its lockfile, a CI job left out of the gate, an invisible character hiding text from reviewers, or a path into someone's home directory each fail the build.
- **Clean Architecture services whose layer rules are tests**, in Go, TypeScript and Python — the same structure proved in three toolchains, with nothing below the composition root reading the clock, randomness or the environment, one storage suite a replacement store must pass, and the same API proved by one contract every service is started and checked against: every move between statuses, every limit at its bound, every configuration value it must take or refuse, a request id and one log line per request, and an OpenAPI description held to the same cases.
- **One statement of the rules.** The statuses and legal moves are written once, and every module that repeats them, the MCP server, the web app and the library included, is checked against that statement.
- **A feature-sliced web app and a publishable library**, each with its import or packaging rules checked.
- **An MCP server for agents**, built on the official SDK and tested through a real client, not a mock.
- **Architecture as code.** A LikeC4 model with rules checked in CI.
- **One set of instructions for agents.** `AGENTS.md` is the only copy; `CLAUDE.md`, `GEMINI.md` and Copilot's file point at it, and a check fails when one starts saying something else.
- **Selectable features, tested.** CI generates a project from every preset and runs that project's own checks, and a project can add or remove a feature later with the same three-way merge that brings in template releases.
- **The same checks everywhere.** Node modules lint and format with Biome, from one configuration, as Go and Python modules do with their own tools; local runs refuse a Node other than CI's and a pinned tool at another version; CI runs each module's checks from the same `module.json` through the same script; a cloud agent's session gets CI's toolchains before its first command; the chassis runs on Windows in CI; and every module's coverage is reported without being gated.

## Start a project

1. **[Use this template](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/generate)** to create a new repository, then clone it.
2. List the features and presets:

   ```bash
   node template/init.mjs --list
   ```

3. Initialize. This needs Node <!-- generated:version .node-version -->24<!-- /generated --> and a clean working tree. Run in a terminal, init reads the owner and repository from `origin`, asks for anything else, shows the plan and waits for your confirmation:

   Initialization verifies stable publication and generates from that upstream commit. If publication is pending or failed, it stops before writing project files. Keep `.template-provenance.json` committed; updates use its exact source and original inputs. For offline generation and candidate testing, see [template source guidance](template/README.md#exact-source-and-reconstruction).

   ```bash
   node template/init.mjs
   ```

   Or pass everything, for scripts: `node template/init.mjs --preset fullstack-ts` or `--features go-service,release`, with `--name`/`--owner` to override the defaults, `--description "…"` for the sentence under the project's README title (without it, init writes one from the features), and `--dry-run` to see the plan only.

4. Install, verify and commit:

   ```bash
   node scripts/setup.mjs && node scripts/verify.mjs
   git add -A && git commit -m "chore: initialize project"
   ```

5. Push, then apply the settings GitHub does not copy from a template: squash-only merging, a ruleset on `main` requiring a pull request and the **`verify`** check, Dependabot security updates, private vulnerability reporting and secret scanning. Preview with `--dry-run`; it needs the GitHub CLI signed in as a repository admin.

   ```bash
   git push && node scripts/configure-github.mjs
   ```

## Presets and features

<!-- generated:presets-table -->
| Preset | Features |
|---|---|
| `minimal` | none: the chassis only |
| `go-api` | `go-service`, `architecture`, `release`, `devcontainer` |
| `py-api` | `py-service`, `architecture`, `release`, `devcontainer` |
| `fullstack-ts` | `ts-service`, `web`, `architecture`, `release`, `devcontainer` |
| `library` | `ts-library`, `release`, `devcontainer` |
| `mcp` | `mcp-server`, `release`, `devcontainer` |
| `all` | every feature |
<!-- /generated -->

<!-- generated:features-table -->
| Feature | What you get |
|---|---|
| `go-service` | Go HTTP service in Clean Architecture layers, standard library only; a test enforces the layer rules; golangci-lint; distroless image |
| `ts-service` | TypeScript HTTP service run directly by Node; pure domain core; import boundaries checked on every file; no runtime dependencies |
| `mcp-server` | MCP server on the official SDK: task tools over stdio or Streamable HTTP for an AI assistant, same layers, driven in tests by a real client |
| `py-service` | Python HTTP service on the standard library: pure domain, WSGI transport, ruff and strict mypy, layer rules enforced by an `ast`-based check |
| `web` | React + Vite app organised by feature (bulletproof-react), import boundaries checked on every file, unit and component tests |
| `ts-library` | TypeScript library for npm: one `exports` entry, publint and are-the-types-wrong checks on the packed tarball, which is also installed into an empty project and imported, tokenless trusted publishing with provenance |
| `architecture` | LikeC4 model of the system, with model rules as tests and an opt-in GitHub Pages site |
| `release` | release-please: release pull requests, tags and `CHANGELOG.md` from Conventional Commits |
| `devcontainer` | Dev Container with the toolchains of the features you selected |
<!-- /generated -->

Init deletes the features you did not select, keeps or removes the marked blocks in shared files such as workflows and this README, replaces the template's name and owner with yours, and deletes itself. [template/README.md](template/README.md) explains the mechanism and how to add a feature.

## What it leaves out

Deployment targets and infrastructure, databases and migrations, authentication, message queues, UI frameworks beyond the minimal React app, and desktop or mobile clients. Each is a product choice with more than one good answer, so each project makes it; [template/README.md](template/README.md#scope) says why.

## Read more

[docs/README.md](docs/README.md) indexes the documentation, [AGENTS.md](AGENTS.md) holds the rules every contributor and coding agent follows, and [template/README.md](template/README.md) covers how the template is versioned and released.

---
<!-- ultra:end template -->

## Getting started

You need:

- Node <!-- generated:version .node-version -->24<!-- /generated --> (`.node-version`), for the scripts and every Node module.
<!-- ultra:begin go-service -->
- Go <!-- generated:version services/api-go/go.mod -->1.26<!-- /generated --> (`services/api-go/go.mod`), and golangci-lint <!-- generated:tool golangci-lint -->2.14.0<!-- /generated --> for the complete local check: `node scripts/tools.mjs install --local` installs it at that version. Without it, `verify.mjs` reports golangci-lint as skipped, and CI still runs it.
<!-- ultra:end go-service -->
<!-- ultra:begin py-service -->
- Python <!-- generated:floor services/api-py/pyproject.toml -->3.13<!-- /generated --> or newer and [uv](https://docs.astral.sh/uv/) <!-- generated:tool uv -->0.12.23<!-- /generated --> (`services/api-py/.python-version`, `scripts/tools/tools.json`), which installs the rest.
<!-- ultra:end py-service -->
- The GitHub CLI, only to apply repository settings with `configure-github.mjs`.

Each toolchain version is pinned once, in the file named beside it above, so there is no `.tool-versions` to keep in step; mise and asdf can read those files directly.

1. Install the dependencies of every module present:

   ```bash
   node scripts/setup.mjs
   ```

2. Run the checks every CI job runs on the code:

   ```bash
   node scripts/verify.mjs             # everything
   node scripts/verify.mjs <module>    # the chassis plus the named modules only
   ```

   It runs each module's own checks and tests, and the API contract against every task service present, on the Node major `.node-version` names, and fails on any other. A check it cannot run fails. One whose tool or condition this machine lacks is reported as skipped by name, never as passed: a pinned tool that is not installed (`node scripts/tools.mjs install --local` installs them), Go's race detector where there is no C compiler, and actionlint's shell-script rules where there is no shellcheck. When the reason for a skip is not clear from that, `node scripts/doctor.mjs` reports as JSON what the checkout needs before a check can run — offline, changing nothing. A few checks run only in CI, because they need a container engine or a network service: `npm audit signatures`, building and starting each container image, and the report-only scans in `security.yml`.

3. Start what you are working on. Each module's entry under *What's here* names the command that starts it, and `node scripts/dev.mjs` starts the task service and every module that runs alongside it, stopping them as one tree; `--api <id>` picks the task service when several are present.

## What's here

- `scripts/` — `setup.mjs` installs every module, `verify.mjs` runs every module's checks, `dev.mjs` starts the development stack, `doctor.mjs` reports what the checkout needs before a check can run, `check-hygiene.mjs` guards the repository's shape, `check-docs.mjs` its documentation, and `configure-github.mjs` applies the repository settings (squash merging, the required `verify` check, security features). In CI, `coverage-summary.mjs` reports each module's coverage and `check-pins.mjs` the hand-pinned tools with a newer release.
<!-- ultra:begin go-service|ts-service|py-service -->
- `scripts/check-contract.mjs` — holds every task service to the one API contract, whose cases are in `scripts/contract/` beside the OpenAPI document it holds to them.
<!-- ultra:end go-service|ts-service|py-service -->
<!-- ultra:begin mcp-server|web|ts-library -->
- `scripts/check-facts.mjs` — holds every module that repeats a fact without serving it (the task rules, the API's default port) to the file that states it.
<!-- ultra:end mcp-server|web|ts-library -->
<!-- ultra:begin go-service -->
- `services/api-go/` — Go task API in Clean Architecture layers. `go run ./cmd/api` there serves it on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated -->. [README](services/api-go/README.md)
<!-- ultra:end go-service -->
<!-- ultra:begin ts-service -->
- `services/api-ts/` — TypeScript task API with a pure domain core. `npm start` there serves it on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated -->. [README](services/api-ts/README.md)
<!-- ultra:end ts-service -->
<!-- ultra:begin py-service -->
- `services/api-py/` — Python task API, same routes and layers. `uv run --directory src python -m api_py.main` there serves it on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated -->. [README](services/api-py/README.md)
<!-- ultra:end py-service -->
<!-- ultra:begin mcp-server -->
- `services/mcp-server/` — MCP server exposing the task API to an AI assistant. `npm start` there serves it over stdio, calling the task API at `TASK_API_URL`; the README shows how to register it with a client. [README](services/mcp-server/README.md)
<!-- ultra:end mcp-server -->
<!-- ultra:begin web -->
- `apps/web/` — React single-page app, organised by feature. `npm run dev` there serves it at http://localhost:5173, with `/api` passed to a task service on port <!-- generated:contract config.PORT.default.value -->8080<!-- /generated -->; `node scripts/dev.mjs` starts it and a task service together. [README](apps/web/README.md)
<!-- ultra:end web -->
<!-- ultra:begin ts-library -->
- `packages/ts-library/` — TypeScript library published to npm. `npm run verify` there builds it and checks the package consumers would install. [README](packages/ts-library/README.md)
<!-- ultra:end ts-library -->
<!-- ultra:begin architecture -->
- `architecture/` — LikeC4 model of the system. `npm run dev` there previews every view. [README](architecture/README.md)
<!-- ultra:end architecture -->
- `docs/` — [the documentation index](docs/README.md) and the rules for keeping it true; `docs/adr/` holds the architecture decision records.
- `.claude/skills/` — step-by-step procedures coding agents follow for recurring tasks. `.github/prompts/` holds Copilot prompt files that wrap one of them; `AGENTS.md` holds the rules all of them follow.
- `.github/` — workflows, issue forms, pull request template, Dependabot and code owners.

## Working with a coding agent

[AGENTS.md](AGENTS.md) holds the rules every coding agent follows here; `CLAUDE.md`, `GEMINI.md` and Copilot's instructions point to it rather than repeating it. For a recurring task, such as recording a decision, changing the task contract or taking a template update, the matching procedure in `.claude/skills/` is the one to follow. Ask the agent to run `node scripts/verify.mjs` and to say what it ran before it reports a change as done. In a Claude Code cloud session, `.claude/settings.json` has the session prepare itself first — the Node `.node-version` names, the pinned tools, then setup — so the agent's first `verify` checks what CI checks.

## Continuous integration

- **`verify.yml`** — on every pull request, every push to `main`, and in a merge queue: repository hygiene, chassis tests on Linux and on Windows, the pinned actionlint and zizmor run through `verify.mjs`, zizmor's online audit of the workflows ([zizmor](https://docs.zizmor.sh)), a blocking gitleaks scan of the commits the change adds, the agent environment run from the oldest Node it supports, and one job per module, which runs what the module's `module.json` names through the same `verify.mjs` a contributor runs — its checks, the API contract, its facts, its end-to-end check — then writes its test coverage to the job summary, reported and never gated, and starts its container image and holds it to the contract's defaults and clean shutdown. All of them feed the aggregate **`verify`** job, the only required check ([ADR-0002](docs/adr/0002-one-required-check.md), [ADR-0011](docs/adr/0011-what-local-verify-guarantees.md), [ADR-0014](docs/adr/0014-modules-describe-themselves.md)).
- **`pr-title.yml`** — pull request titles follow Conventional Commits.
- **`copilot-setup-steps.yml`** — the environment GitHub's Copilot coding agent prepares before it works here: every toolchain the selected features need, then `node scripts/setup.mjs`. It runs on its own only when it changes.
- **`security.yml`** — report-only scans that fail only when a scan could not run: gitleaks over new commits and weekly over history, `npm audit` for every npm lockfile, and a Trivy scan of every container image the repository builds, for fixable high and critical vulnerabilities in its operating-system and language packages.
<!-- ultra:begin go-service -->
- **`security.yml`, Go** — govulncheck, reporting only vulnerabilities in code the Go service actually calls.
<!-- ultra:end go-service -->
<!-- ultra:begin py-service -->
- **`security.yml`, Python** — pip-audit over the Python service's lockfile.
<!-- ultra:end py-service -->
- **`pins.yml`** — weekly, report-only: which tools pinned by hand in `scripts/tools/tools.json` have a newer release. It never moves a pin; [docs/toolchain-updates.md](docs/toolchain-updates.md) says how. Its `checksums` job, weekly and on every pull request that changes a pin, fails when a pinned SHA-256, for any platform, differs from the one its release publishes.
- **`codeql.yml`** — CodeQL analysis; enable it by setting the repository variable `CODEQL_ENABLED=true` (needs a public repository or GitHub Advanced Security).
- **`scorecard.yml`** — [OpenSSF Scorecard](https://scorecard.dev): an outside measurement of the practices this repository claims, published and uploaded to code scanning; enable it with `SCORECARD_ENABLED=true` on a public repository. Some checks measure the project rather than the workflows, and a new or single-maintainer repository scores low on them: Code-Review and Branch-Protection while pull requests merge without a second person's review, Maintained for its first 90 days, SAST until CodeQL has run on recent pull requests, and CII-Best-Practices until the project registers for the badge.
<!-- ultra:begin mcp-server -->
- **`mcp-publish.yml`** — after a release, pushes the MCP server's image, built for amd64 and arm64, to GitHub Container Registry with a build provenance attestation, and its `server.json` to the MCP Registry, tokenlessly; enable it with `MCP_PUBLISH_ENABLED=true` ([how](services/mcp-server/README.md#publish)).
<!-- ultra:end mcp-server -->
<!-- ultra:begin release -->
- **`release.yml`** — release-please on `main`, off until `RELEASE_ENABLED=true`, which `configure-github.mjs` sets. Releases start at `0.1.0`. GitHub holds the checks of a pull request opened by `github-actions[bot]` until someone approves them, so releasing is: open the release pull request, *Approve workflows to run*, wait for `verify`, merge. A `RELEASE_PLEASE_TOKEN` secret holding a GitHub App or personal token removes that step.
<!-- ultra:end release -->
<!-- ultra:begin ts-library -->
- **Library publishing** — with `release` selected, each release publishes `packages/ts-library` to npm with provenance once `NPM_PUBLISH_ENABLED=true` is set and npm trusts the workflow ([how](packages/ts-library/README.md#publish)).
<!-- ultra:end ts-library -->
<!-- ultra:begin architecture -->
- **`architecture.yml`** — publishes the architecture model to GitHub Pages once `PAGES_ENABLED=true` is set.
<!-- ultra:end architecture -->
<!-- ultra:begin template -->
- **`template-test.yml`** — template only: generates a project from every preset and runs its setup and verify.
<!-- ultra:end template -->

Dependabot proposes grouped updates weekly for every ecosystem present, SHA-pinned actions and the local actions under `.github/actions/` included, each release seven days after it is published.

## Taking template updates

This project was generated from a repository template, and `CHANGELOG.md` records which one and the release it came from. When a later release fixes something you want, `scripts/template-update.mjs` brings the change in: it regenerates the project as the old and the new release would have made it, with this project's name and features, and applies the difference as a three-way merge. What you changed yourself is kept, and a conflict is left to resolve like any merge conflict.

```bash
node scripts/template-update.mjs --check                 # is a newer release out?
node scripts/template-update.mjs --to vX.Y.Z --dry-run   # what would change
node scripts/template-update.mjs --to vX.Y.Z             # apply, then review, verify and commit
node scripts/template-update.mjs --to latest             # the newest release
```

`--check` works on a dirty tree, because it only reads: it reports as JSON the release the project is on, the newest one the template has, and the command that would move the project to it, and exits 1 when a newer release exists — so a script can ask without parsing the report.

Updates only move forward: a release older than the one the project is on is refused. It works on the whole repository from any directory in it, and prints each release's tag with the commit it names before running that release's code.

The same script changes which features the project has, by the same means: the "after" side is generated with the new selection. Without `--to` it stays on the release the project is on; with it, the release and the selection move in one change. The new selection is recorded in `CHANGELOG.md`, where the next update reads it.

```bash
node scripts/template-update.mjs --add web --dry-run      # what adding the web app would bring
node scripts/template-update.mjs --remove py-service      # give up the Python service
```

A removal is refused, with the paths named, when it would delete a file you changed or leave behind a file of your own inside the feature's directory: move those first, then run it again.

The `update-from-template` skill walks an agent through the whole procedure.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) describes the workflow, [SECURITY.md](SECURITY.md) how to report a vulnerability privately, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) the expected conduct. Guidance for coding agents is in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
