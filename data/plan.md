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
    COMMIT the gate commit on release/3.14.0-check-safety (check-plan.mjs, search_replace.mjs, plan.md, chassis step, ADR-0037; the suite in test/agents-claims.test.mjs holds this invariant to those enforcers)
    CLONE fresh clone of the commit runs node scripts/verify.mjs: OK (actionlint/zizmor skipped, no win32-x64 assets)

### minimal-pr
- id: minimal-pr
- status: pending
- trigger: a hygiene check fails on the template itself and is self-upgradeable
- verdict: write a PR whose diff is limited by scripts/check-safety.mjs caps
  (30% deletion / >25 lines / 20% rewrite) and by catastrophic-edit blocking;
  PR title follows Conventional Commits
- evidence:
    FAIL node --test test/search_replace.test.mjs — catastrophic guard blocks a 31-line removal from a 100-line file (cap = max(25, floor(100*0.3)) = 30; 30 is allowed, 31 is blocked)
    PASS node --test test/search_replace.mjs suite: 24/24 pass; mutation check: pass 1 broken → 15/24 red
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
    PASS generated child project (minimal preset, --source at the gate commit) lists chassis: plan and its node scripts/verify.mjs exits 0

### facts-routes
- id: facts-routes
- status: pending
- trigger: an external-facing fact (status, transition, port, limit) drifts from
  `scripts/rules/task-rules.json` / `scripts/contract/tasks-api.json`
- verdict: never rewrite the SoT; a facts mismatch opens a minimal PR and fails verify
  until a human applies it
- evidence:
    PASS node scripts/check-facts.mjs in the current tree — every module's facts match the files that state them
    FAIL node scripts/check-facts.mjs with mcp-server's apiDefaultPort drifted to 8081 — "mcp-server apiDefaultPort is 8081, expected 8080", exit 1; restored, exit 0

### drift-proof
- id: drift-proof
- status: pending
- trigger: `data/plan.md` gains an entry missing a required field or an evidence line
  without a recognized prefix
- verdict: `scripts/check-plan.mjs` fails CI with exit 1 before any infra change is allowed;
  it reads the plan root from argv or cwd (fixed: argv was parsed but silently ignored)
- evidence:
    PASS node scripts/check-plan.mjs on the well-formed plan — exit 0
    FAIL node scripts/check-plan.mjs on an invalid entry (bad id, unknown status, unprefixed evidence) — exit 1 with three schema violations listed
