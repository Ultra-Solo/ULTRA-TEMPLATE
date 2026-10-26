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

### Backlog: a check date, and no threshold

These are live questions with no observable number. They are not given an invented threshold; they are given a date at which they are decided and the observation that lets them ship.

A date here is a commitment to **decide**, not a promise to build. At that check the item either ships, because its observation fired, or it moves out with an entry appended to the decision log. It never ships unfulfilled and it never quietly disappears. That distinction is the whole point: [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md) planned a milestone of five and shipped one, then remapped the rest across two releases and split them again — each time after a release was already open. An item that cannot ship is moved in the open, at its check, where the move is visible.

Both items are what [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md) deferred: a database, authentication or deployment profile needed "a separate scope decision and maintained upgrade/testing ownership", and update pull requests waited "until discovery proves useful". Neither number is in the repository because neither cost is only ours — a profile adopts a dependency's upgrade and test burden permanently, and [README.md](README.md) leaves deployment, databases and authentication to each project on purpose.

| Question | Decided at the check on | The observation that lets it ship | At that check, if it has not fired |
|---|---|---|---|
| Should the template ship a database, authentication, or deployment profile? | 2026-11-17 | Two or more separate adopters asking for the same profile, **and** a named owner committed to maintaining its upgrades and tests. One adopter is a request; both together are a scope decision | Move to the 2026-12-15 check with a decision-log entry naming which condition was missing. Do not ship a profile to meet a date |
| Should update pull requests be opened automatically? | 2026-11-17 | An adopter asking for it, or a reported update that `template-update.mjs --check` detected and nobody applied | Move to the 2026-12-15 check with a decision-log entry. If the same update is detected and unapplied twice, this fires on the second report rather than waiting |

**Why a date, and not a release.** The first version of this section named v3.15.0 and claimed it was the first minor that could carry a decision from evidence. That was arithmetic done on two incompatible clocks. Measured from the tags, this repository cut 16 releases between 2026-10-05 and 2026-10-19 — nine of them minors — with a median gap of one day between minors, so v3.15.0 would arrive around 2026-10-22, twenty-six days before the 2026-11-17 check the sentence itself named as the earliest evidence. The target preceded its own justification, which means it was not a target at all: it was a deferral dressed as one, and it would have come due before anything could be observed.

The versions here move faster than any evidence can accumulate, so a version cannot mark the point at which evidence should exist. A date can, and the ledger below already uses one. The item is decided at the 2026-11-17 check and released in whatever minor is open then — today's `3.13.4` is not that release, and neither is v3.14.0 or v3.15.0. What the row fixes is the check, not the number.

## Decision log

One entry per cadence check, newest last. A check appends; it never rewrites an entry.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-10-20 | Write this plan, and record it in [ADR-0035](../docs/adr/0035-drive-releases-from-a-written-standing-plan.md) | The ledger [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md) opened is closed, and v3.13.1 through v3.13.3 were maintenance only. The plan was being re-derived at every check, which the procedure names as a failure mode |
| 2 | 2026-10-26 | Actuate trigger row 2 as written: close [GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79) with happy-dom 21.0.4 and ship it as the patch v3.13.7 | The trigger was observed by the check's direct lockfile-versus-advisory-database comparison, which step 2 of the procedure names as raw material, before any instrument the row names had reported it; actuating on that direct observation is within the plan, and this entry is the sentence a future firing cites. The fix was proven by the advisory's PoC — 21.0.3 reached the host filesystem, 21.0.4 did not — and the shipped tarball's integrity equals the registry's record |

## Prediction ledger

The procedure asks for the probability a decision is wrong, and for every prediction a date it becomes checkable. A prediction without one is not registered, so every row below carries its date.

Score a row once its date has passed: the Brier term is `(p − outcome)²` with `p` the probability written here that the prediction fails and `outcome` 1 when it did fail. The running mean is this repository's calibration; it is not a grade on the release.

| # | Prediction | Checkable on | Probability it fails | Outcome | Score |
|---|---|---|---|---|---|
| P1 | Every tool in `scripts/tools/tools.json` is still `current`, so no pin moves | 2026-10-27 | 0.35 | — | — |
| P2 | All four Monday scheduled runs succeed: code scanning, Scorecard, security scans, the preset matrix | 2026-10-26 | 0.15 | — | — |
| P3 | Only pin moves and dependency updates are released in the next four weeks; no new capability is warranted | 2026-11-17 | 0.30 | — | — |
| P4 | The Monday 2026-10-26 05:41Z security scans report no vulnerability in any of the five lockfiles, now that v3.13.7 closed the one they had not yet reported | 2026-10-26 | 0.10 | — | — |
| P5 | A project generated from the published v3.13.7 carries happy-dom 21.0.4 and audits clean | 2026-10-26 | 0.05 | 0 | 0.0025 |
| P6 | The reading entry 2 records — actuation on the check's direct observation, not only on the named instruments — is upheld at the backlog check | 2026-11-17 | 0.20 | — | — |

P5 was registered before the release it predicted, and resolved by the generation check that followed it: the project generated from the published tag carried 21.0.4 and audited clean, so its score is the only one the ledger holds. The other rows' dates have not passed, so they stay unmarked rather than scored as anything.

## Standing state

As of the check on 2026-10-26, from the repository rather than from memory:

- `origin/main` is `c08a0be`, tagged `v3.13.7` — the Latest release, published 2026-10-26T02:39:36Z by the `template-release` workflow on verify's own pass. `template/features.json` says <!-- generated:template-version -->3.13.7<!-- /generated -->, which is the release just shipped; the next version is not written yet. The figure is generated from that file rather than copied, because a copy of it is what this line got wrong first.
- [ADR-0025](../docs/adr/0025-prioritize-verified-foundation-before-capability-expansion.md)'s ledger is closed: A1 in v3.3.0, A2r/A4r/A5 in v3.4.0, B1/B3/B4 in v3.5.0, B2 in v3.6.0. Nothing in it is open.
- Releases v3.6.1 through v3.13.7 added no capability the ledger planned: a runner image pin, MCP Streamable HTTP, the Node, Go and Python lines, agent adapters, the runner move to Ubuntu 26.04, and a security patch no plan foresaw.
- [GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79) is closed in the repository's own lockfile: `npm audit` reports no vulnerability in any of the five lockfiles, and every one of the four selections that ship apps/web carries happy-dom 21.0.4.
- All 11 hand-pinned tools are `current` in the `pins` run of 2026-10-20T11:51:09Z, every platform checksum matching its release. The next `pins` report is due Tuesday 2026-10-27.
- No open issue. Two Dependabot pull requests are open — #73, the actions group across one directory, and #74, the `distroless/static-debian13` base image — both awaiting the next release window, neither part of the patch that just shipped.

## Next checkable dates

- Monday 2026-10-26 — code scanning 04:23Z, Scorecard 05:37Z, security scans 05:41Z, the preset matrix 06:17Z.
- Tuesday 2026-10-27 — the pins report 06:23Z.
- Tuesday 2026-11-17 — the horizon P3 is scored against, and the first check where the backlog above can be decided from evidence rather than assumed. Both items are decided at this check, and released in whatever minor is open then.

A check before those dates can confirm nothing that has not happened yet, and says so rather than inventing an update. The one thing a check must never do is let a backlog date pass without either shipping the item or moving it in the decision log.
