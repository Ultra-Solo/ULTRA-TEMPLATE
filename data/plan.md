# Plan — the self-upgrade gate

This file is the bounded record of the self-upgrade gate: which invariant checks are
self-upgradeable, what a failing check authorizes, and where the rule sits as source of
truth. It is validated by `scripts/check-plan.mjs` (schema + no-drift) and must have one
entry per gate check, in status order: `blocked` → `pending` → `in_progress` → `done`.

## Scope

- **Self-upgradeable (gate owns the fix)** — infrastructure metadata that a `verify` job may
  repair itself: the `upgrade` job entry in `.github/workflows/verify.yml`, its listing in
  `verify.needs`, and the two gate scripts themselves (`check-plan.mjs`, `search_replace.mjs`).
  These are not "source of truth" for external rules.
- **Not self-upgradeable (gate produces a minimal PR)** — everything that states a shared
  rule or serves a consumer: `scripts/rules/task-rules.json`, `scripts/contract/tasks-api.json`,
  each module's `module.json`, `scripts/verify.mjs`, `scripts/check-hygiene.mjs` rules,
  `scripts/modules.mjs`. The gate diffs, computes the minimal fix, and opens a PR instead of
  writing these files.
- **Never self-upgradeable** — `scripts/configure-github.mjs` (single required check rule),
  ADRs, and the `.github` ruleset; these are written only by a human review of the minimal PR.

## Entry template

```
### <id>
- status: <pending | in_progress | done | blocked>
- trigger: <what failed and why it is upgradeable>
- verdict: <the minimal fix and why it stays within the gate's caps>
- evidence:
    PASS <command that passed>
    FAIL <command that failed before the fix>
    PR <github pull request url or "opened on ...">
    CLONE <fresh clone reproduction of verify>
```

## Entries

### gate-setup
- id: gate-setup
- status: done
- trigger: requirement to register a new invariant-check upgrade path in `verify.yml`
- verdict: the gate runs as a chassis step (`chassis: plan` in scripts/verify.mjs), not a new
  CI job, so the one-required-check rule (ADR-0002) is untouched and `verify.needs` and
  `scripts/configure-github.mjs` need no change (ADR-0037)
- evidence:
    PASS node scripts/check-plan.mjs (plan schema OK, 5 entry/entries)
    PASS node --test template/*.test.mjs (97/97 pass)
    PASS npm audit signatures in the fresh clone: api-ts 3, mcp-server 10, apps/web 42, ts-library 13 packages with verified attestations, all exit 0
    COMMIT 4b118c8 on release/3.15.0-self-upgrade-gate, the branch v3.15.0 is released from (scripts/check-plan.mjs, scripts/search_replace.mjs, data/plan.md, the chassis: plan step in scripts/verify.mjs, ADR-0037, test/check-plan.test.mjs; the suite in test/agents-claims.test.mjs holds this invariant to those enforcers)
    CLONE a clean clone of b9f32f9 and a clean clone of the gate commit fail the same 8 chassis steps, so the gate adds no failure: actionlint and zizmor are skipped by name for want of win32-x64 assets, uv 0.12.5 sits below py-service's >=0.13.0 floor, and npm 12 rejects the --ignore-scripts default. A minimal-preset child generated from the gate commit runs node scripts/verify.mjs with exit 0 and verify: OK

### minimal-pr
- id: minimal-pr
- status: pending
- trigger: a hygiene check fails on the template itself and is self-upgradeable
- verdict: write a PR whose diff is limited by scripts/check-safety.mjs caps
  (30% deletion / >25 lines / 20% rewrite / contiguous hunk over 10 lines) and by
  catastrophic-edit blocking;
  PR title follows Conventional Commits
- evidence:
    FAIL node --test test/search_replace.test.mjs — catastrophic guard blocks a 31-line removal from a 100-line file (cap = max(25, floor(100*0.3)) = 30; 30 is allowed, 31 is blocked)
    PASS node --test test/search_replace.test.mjs — 28/28 pass
    PASS ten mutants of the matcher, each confirmed landed and restored by SHA-256: pass 1 disabled 2 of 28 red, rstripEndings no-op 1, pass 2 disabled 2, pass 3 disabled 3, pass 4 disabled 1, pass 5 disabled 0, guard never blocks 2, guard always blocks 19, exactMatch always true 17, boundary > to >= 3
  The one surviving mutant is equivalent, not a coverage gap. Pass 5 compares lines after
  stripping trailing whitespace only, which is strictly weaker than Pass 2's trim of both
  sides, and Pass 2 runs first — so every single-line input Pass 5 could match, Pass 2
  already matched. The matcher was instrumented and run over an exhaustive 187,272-case
  space (every one- and two-line block and search over a 17-string vocabulary, in both
  line-ending styles) and a randomized 200,000-case corpus: Pass 5 was entered 364,661
  times and returned a match 0 times. Pass 5 stays as port fidelity and defense-in-depth,
  which test/search_replace.test.mjs already states in its "Pass 5 single-line anchor:
  shadowed by Pass 2's trim" case, so no test can kill that mutant without deleting the
  pass — and deleting it would break the five-pass port ADR-0037 describes.
    PR pending — no hygiene repair has been required yet

### gate-repair
- id: gate-repair
- status: pending
- trigger: the gate's own registration drifts — the `chassis: plan` step in
  `scripts/verify.mjs`, or `check-plan.mjs` / `search_replace.mjs` themselves
- verdict: repair is never self-written; scripts/verify.mjs is in the not-self-upgradeable
  list, so a fix goes through the minimal-PR contract with matcher caps applied. No `upgrade`
  CI job exists to drift: the gate is a chassis step (ADR-0037)
- evidence:
    PASS node scripts/verify.mjs --dry-run lists the chassis: plan step
    PASS generated child project (minimal preset, --source . --source-commit 4b118c80a009603a41762021fa1b331c48f75e8c) carries chassis: plan at scripts/verify.mjs:59, and after git init its node scripts/verify.mjs exits 0 with verify: OK (119 tracked files, 164 pass, 3 skipped)

### facts-routes
- id: facts-routes
- status: pending
- trigger: an external-facing fact (status, transition, port, limit, route) drifts from
  `scripts/rules/task-rules.json` / `scripts/contract/tasks-api.json` /
  `scripts/contract/openapi.json`
- verdict: never rewrite the SoT; a facts mismatch opens a minimal PR and fails verify
  until a human applies it. A route is a fact by the same definition: `check-facts.mjs`
  compares a module's printed copies of it, and `routesDeclared` in
  `architecture/rules.mjs` compares a diagram's claims about it with
  `scripts/contract/openapi.json`, so a route reaches the model only after it reaches
  the contract (ADR-0050). Neither repairs the SoT
- evidence:
    PASS node scripts/check-facts.mjs in the current tree — every module's facts match the files that state them
    FAIL node scripts/check-facts.mjs with mcp-server's apiDefaultPort drifted to 8081 — "mcp-server apiDefaultPort is 8081, expected 8080", exit 1; restored, exit 0
    PASS routesDeclared on the tree ADR-0050 ships — 0 findings in architecture/, `npm run verify` exit 0, `node --test test/model.test.mjs` 4/4 pass
    FAIL routesDeclared on the tree ADR-0049 opened — the dynamic view named `POST /api/tasks/{id}/move`, which `scripts/contract/openapi.json` does not declare: "taskMove: step \"POST /api/tasks/{id}/move\" names POST /api/tasks/{id}/move, which the contract does not declare", 9 findings at the `all` preset and 1/1/2 at go-api/py-api/fullstack-ts, exit 1; unchanged in every module other than architecture/

### drift-proof
- id: drift-proof
- status: pending
- trigger: `data/plan.md` gains an entry missing a required field or an evidence line
  without a recognized prefix
- verdict: `scripts/check-plan.mjs` fails CI with exit 1 before any infra change is allowed;
  it reads the plan root from argv or cwd (fixed: argv was parsed but silently ignored)
- evidence:
    PASS node scripts/check-plan.mjs on the well-formed plan — exit 0
    PASS node --test test/check-plan.test.mjs — 24/24 pass
    PASS seven mutants of scripts/check-plan.mjs, each confirmed landed and restored by SHA-256: status validation off 2 of 24 red, evidence prefix off 1, evidence required off 2, id validation off 2, empty-file check off 1, exit 1 to exit 0 15, fence skipping off 3
    FAIL node scripts/check-plan.mjs on an invalid entry (bad id, unknown status, unprefixed evidence) — exit 1 with three schema violations listed
