# The standing plan a cadence check starts from

The procedure is [`.github/agents/release-cadence.agent.md`](../.github/agents/release-cadence.agent.md). This file is its prior: the triggers, what each one is judged by, the response already decided for it, what earlier checks decided, and what they predicted.

It lives here because it is about maintaining ULTRA-TEMPLATE itself, like [README.md](README.md) beside it. Everything in `template/` is deleted when a project is initialized, so nothing here reaches an adopter and nothing here changes generated output. A generated project's first cadence check writes its own, as the procedure's first step says.

**Do not re-derive a trigger that is written here.** A check that regenerates this table has skipped the step it was supposed to run.

## Triggers

Each row is observed, judged against a number, and answered with a response written before the trigger fired — so the answer is chosen when nothing is broken. The schedules below are read from `.github/workflows/`, and `template/cadence.test.mjs` fails when a workflow's schedule is missing from this table or this table keeps a schedule no workflow has.

| Trigger | Observed how | Threshold | Response already decided |
|---|---|---|---|
| A hand-pinned tool falls behind upstream | `.github/workflows/pins.yml` — `23 6 * * 2`, Tuesdays 06:23Z; it lists each tool in `scripts/tools/tools.json` beside its latest release and checks every platform's checksum | The run reports a tool that is not `current`, or a checksum that does not match its release | Move the pin with `node scripts/tools.mjs bump`, in a patch release. A pin is never moved from memory: the run names the release, the bump command resolves it |
| A dependency advisory lands on a shipped dependency | `.github/workflows/security.yml` — `41 5 * * 1`, Mondays 05:41Z | Any advisory the scan reports, or Dependabot opening a PR | Fix or update on a release branch; a dependency update advances the version, so this is a patch release even when it is the only change |
| Code scanning finds something | `.github/workflows/codeql.yml` — `23 4 * * 1`, Mondays 04:23Z | The same finding present on two consecutive scheduled runs | Treat as a defect: reproduce it, then fix it. One scheduled run is investigated, not acted on |
| The OpenSSF Scorecard score drops | `.github/workflows/scorecard.yml` — `37 5 * * 1`, Mondays 05:37Z | A drop in a check the repository controls, sustained across two runs | Name the check, fix that one thing, in a patch release. A score that moves on the checks it does not control is reported, not chased |
| A preset fails to generate or verify | `.github/workflows/template-test.yml` — `17 6 * * 1`, Mondays 06:17Z. Template-only: initialization removes this workflow | The same preset failing two consecutive runs | The preset is broken for adopters: fix before any other work. A single flake is re-run once, then investigated |
| A toolchain line moves | The upstream release announcement for Node, Go, Python, or the runner image — not this repository | A new LTS or stable line is generally available | Validate the whole gate on the new line first, then move every copy in one minor release: the version is declared once and each copy must agree ([ADR-0013](../docs/adr/0013-declare-each-fact-once.md), [ADR-0031](../docs/adr/0031-track-the-node-lts-line.md), [ADR-0032](../docs/adr/0032-track-the-current-stable-go-line.md), [ADR-0033](../docs/adr/0033-track-the-current-stable-python-line.md)) |

### Triggers with no threshold yet

These are live questions with no observable number, so they are recorded as unfired rather than given an invented threshold. Each names the observation that would fire it; until that observation exists, a check reports them as unfired and moves on.

| Question | Why it has no threshold | The observation that fires it |
|---|---|---|
| Should the template ship a database, authentication, or deployment profile? | [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md) deferred these to "a separate scope decision and maintained upgrade/testing ownership". The number is not in the repository because the cost is not only ours: a profile adopts a dependency's upgrade and test burden permanently, and [README.md](README.md) leaves deployment, databases and authentication to each project on purpose | Two or more separate adopters asking for the same profile, **and** a named owner committed to maintaining its upgrades and tests. One adopter is a request; both together are a scope decision |
| Should update pull requests be opened automatically? | Deferred "until discovery proves useful", and usefulness is not measurable from here | An adopter asking for it, or a reported update that `template-update.mjs --check` detected and nobody applied |

## Decision log

One entry per cadence check, newest last. A check appends; it never rewrites an entry.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-10-20 | Write this plan, and record it in [ADR-0035](../docs/adr/0035-drive-releases-from-a-written-standing-plan.md) | The ledger [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md) opened is closed, and v3.13.1 through v3.13.3 were maintenance only. The plan was being re-derived at every check, which the procedure names as a failure mode |

## Prediction ledger

The procedure asks for the probability a decision is wrong, and for every prediction a date it becomes checkable. A prediction without one is not registered, so every row below carries its date.

Score a row once its date has passed: the Brier term is `(p − outcome)²` with `p` the probability written here that the prediction fails and `outcome` 1 when it did fail. The running mean is this repository's calibration; it is not a grade on the release.

| # | Prediction | Checkable on | Probability it fails | Outcome | Score |
|---|---|---|---|---|---|
| P1 | Every tool in `scripts/tools/tools.json` is still `current`, so no pin moves | 2026-10-27 | 0.35 | — | — |
| P2 | All four Monday scheduled runs succeed: code scanning, Scorecard, security scans, the preset matrix | 2026-10-26 | 0.15 | — | — |
| P3 | Only pin moves and dependency updates are released in the next four weeks; no new capability is warranted | 2026-11-17 | 0.30 | — | — |

No row has resolved, so the ledger is too young to score. That is stated rather than scored as zero.

## Standing state

As of the check on 2026-10-20, from the repository rather than from memory:

- HEAD is `1852bd4`, tagged `v3.13.3`. `template/features.json` says `3.13.3`.
- [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md)'s ledger is closed: A1 in v3.3.0, A2r/A4r/A5 in v3.4.0, B1/B3/B4 in v3.5.0, B2 in v3.6.0. Nothing in it is open.
- Releases v3.6.1 through v3.13.3 added no capability the ledger planned: a runner image pin, MCP Streamable HTTP, the Node, Go and Python lines, agent adapters, and the runner move to Ubuntu 26.04.
- All 11 hand-pinned tools are `current` in the `pins` run of 2026-10-20T11:51:09Z, every platform checksum matching its release.
- No open issue and no open pull request.
- Nothing is waiting on a decision. The next event that can change this state is the scheduled runs below.

## Next checkable dates

- Monday 2026-10-26 — code scanning 04:23Z, Scorecard 05:37Z, security scans 05:41Z, the preset matrix 06:17Z.
- Tuesday 2026-10-27 — the pins report 06:23Z.

A check before those dates can confirm nothing that has not happened yet, and says so rather than inventing an update.
