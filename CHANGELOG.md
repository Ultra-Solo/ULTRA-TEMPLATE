# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

<!-- ultra:begin release -->
Released sections are written by release-please from Conventional Commit titles; do not edit them by hand.
<!-- ultra:end release -->

## [Unreleased]

### Added

- `scripts/check-safety.mjs`: the bounded-artifact mutation gate — rejects any file losing more than
  30% of its lines and more than 25 lines in one change unless a compensating rewrite is in progress
  (additions ≥ 20% of the original file); whole-file deletions are reported as changes, not rejections
  ([test/check-safety.test.mjs](test/check-safety.test.mjs)).
- `scripts/verify.mjs`: the check-safety gate as a chassis step, so it runs like the other CI controls.
- `scripts/hooks/check-safety`: an optional pre-commit hook wrapper that invokes the gate on staged work.
  Install with `cp scripts/hooks/check-safety .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`.
- `scripts/check-plan.mjs`: the self-upgrade gate — validates every entry in `data/plan.md` (id, status,
  trigger, verdict, evidence) on each run and fails on drift, so a repair outside a written entry is a
  minimal pull request rather than a direct write ([ADR-0037](docs/adr/0037-bound-the-self-upgrade-gate-to-a-validated-plan.md),
  [test/check-plan.test.mjs](test/check-plan.test.mjs)).
- `scripts/search_replace.mjs`: the deterministic five-pass matcher those pull requests are computed with,
  which blocks a catastrophic edit instead of applying it ([test/search_replace.test.mjs](test/search_replace.test.mjs)).
- `scripts/verify.mjs`: the plan check as a `chassis: plan` step, so the gate runs like the other CI controls.
- `data/plan.md`: what the gate may repair, as five entries each with a status, trigger, verdict and evidence.

### Changed

- `template/features.json`: 3.14.0 → 3.15.0, with its release notes in `template/notes/v3.15.0.md`.

### Fixed

- `scripts/check-safety.mjs`: corrected numstat parsing (addition/deletion columns and the uncounted
  `-` marks are now handled in the right order), fixed the compensating-rewrite measurement to be
  anchored to the original file rather than the resulting file, and widened the diff queries so that
  files deleted in the index are still visible and classified as deletions rather than accepted as
  silent mass mutations.
- `scripts/search_replace.mjs`: the truncation-artifact pattern that recognises a comment-only ellipsis
  backtracked exponentially on a line such as `#...` followed by slashes and any other character —
  18 seconds on a 49-character line, reported by CodeQL as `js/redos`. It is now written with character
  classes and accepts exactly the same lines, in linear time
  ([test/search_replace.test.mjs](test/search_replace.test.mjs)).
