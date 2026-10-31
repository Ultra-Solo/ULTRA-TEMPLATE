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

### Fixed

- `scripts/check-safety.mjs`: corrected numstat parsing (addition/deletion columns and the uncounted
  `-` marks are now handled in the right order), fixed the compensating-rewrite measurement to be
  anchored to the original file rather than the resulting file, and widened the diff queries so that
  files deleted in the index are still visible and classified as deletions rather than accepted as
  silent mass mutations.
