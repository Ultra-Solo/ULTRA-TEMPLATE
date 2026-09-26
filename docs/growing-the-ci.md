# Growing the CI

The workflows start simple on purpose: every job runs on every pull request and every push to `main`, and one aggregate job, `verify`, is the only required check ([ADR-0002](adr/0002-one-required-check.md)). That stays right until CI is slow enough to matter. When it is, these are the changes that keep the single required check honest — and the traps each one sets.

## Skip work a change cannot affect

**Never put `paths:` on `verify.yml` itself.** A required check that is filtered out never reports, and GitHub waits for it forever: the pull request cannot merge and nothing says why.

Filter inside a job instead, and decide what "skipped" means to the gate. The gate passes only when every job it needs *succeeded*, and a job skipped by an `if:` reports `skipped`, so adding one turns the gate red. Two ways out:

- **Keep the job, skip its steps.** A first step compares the changed files and every later step is conditional on its output. The job still reports `success`, and the gate needs no change. This is the simpler choice.
- **Skip the job, and teach the gate.** Change the gate's check from `result == "success"` to accept `skipped` for the jobs you filter, by name. Never accept `skipped` for all of them: a job that is skipped because something upstream broke would then read as a pass.

A job that decides what changed must see every file in the pull request. The files API paginates, so read it with `gh api --paginate "repos/$REPO/pulls/$PR/files"`: the single-response diff endpoint gives up on large pull requests.

## Share steps between jobs

When three or more jobs repeat the same setup, move it into a reusable workflow (`on: workflow_call`) or a local composite action under `.github/actions/`. `check-hygiene` applies the same pinning rules to both. A called workflow cannot hold more permissions than its caller grants, so a caller with `contents: read` makes a called job that needs `security-events: read` fail at startup — grant it on the calling job. GitHub checks this before any `if:`, so the run fails even when every job would be skipped; `check-hygiene` rule 18 fails the caller on the pull request instead.

A matrix job is one entry in the gate's `needs`: its result is the combined result of every leg.

## Turn on a merge queue

The queue runs required checks on its own temporary branch, and a required check that does not run there leaves every queued pull request waiting. `verify.yml` already runs on `merge_group`, so the one required check is ready. Any other workflow you make required needs the same trigger before you enable the queue.

## Move slow suites off the pull request

End-to-end, soak and performance tests that take minutes or flake on shared runners belong on a schedule or a manual dispatch, reporting to the team rather than blocking a merge. A timing assertion that fails one run in fifty teaches people to press *re-run* without reading; keep those out of the required path, and keep the fast, deterministic checks in it.
