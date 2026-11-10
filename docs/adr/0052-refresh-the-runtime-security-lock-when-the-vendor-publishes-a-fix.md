# ADR-0052: Refresh the runtime security lock when the vendor publishes a fix

**Status:** Accepted · Amends [ADR-0024](0024-lock-runtime-security-payloads.md) · **Date:** 2026-11-07

## Context

The digest-pinned `python:3.15-slim` base (Debian 13 trixie) ships `zlib1g 1:1.3.dfsg+really1.3.1-1+b1`. Debian security advisory DSA-6613-1 (Debian bugs 1153063 and 1146895, upstream commit df84af25) fixes two heap buffer overflows in that version — a stale `strm.next_in` in `gz_write` after a failed write (CVE-2026-76844) and a stale external buffer in `gz_vacate` on non-blocking `gzwrite` (CVE-2026-85091) — in `1:1.3.dfsg+really1.3.1-1+deb13u1` in trixie-security. The `py-image-security` jobs reject fixable high/critical findings, so the required `verify` gate failed on PR #114 even though the same jobs were green on `main` hours earlier: the fix and the vulnerability database entry landed between those runs. This is external vendor drift, not a defect introduced by the branch, but the branch must carry the repair because `verify` is the required check.

## Decision

- Add `zlib1g` at the fixed version `1:1.3.dfsg+really1.3.1-1+deb13u1` to `services/api-py/security-packages.json`, with the exact official pool path and SHA-256 for every one of the eight base architectures. Checksums come from the signed `trixie-security` `Packages.xz` indexes (verified against Debian's archive keyring via the signed Release/InRelease files); each downloaded `.deb` was independently re-hashed against the index value and all eight match.
- Before pinning, re-check every other locked package against the current signed index: `libpcre2-8-0`, `libssl3t64`, `openssl` and `openssl-provider-legacy` still match, so only `zlib1g` moves. The base image digest is unchanged and is never downgraded; when a rebuilt official base ships the fixed zlib, the lock entry is removed per ADR-0024.
- The lock-count test in `services/api-py/tests/test_security_packages.py` now expects five packages.

## Alternatives considered

- **Wait for a rebuilt official Python base** — the fix is available now in the signed security suite; ADR-0024 already rejects waiting when a verified payload exists.
- **Run `apt update` in the Docker build** — rejected by ADR-0024: changing indexes are not repeatable build inputs and record no exact bytes.
- **Ignore the two findings in the scanner policy** — the findings are fixable; the ignore policy exists for unfixed or lower-severity findings, and weakening it would hide the next drift.
- **Pin only amd64/arm64** — the lock file is validated for all eight base architectures and the installer refuses an unknown architecture, so a partial lock would break the other six builds.

## Consequences

- The runtime image installs a vendor-fixed zlib from verified bytes, so `py-image-security` and therefore `verify` pass again on both native platforms.
- The lock file grows by one package; every future vendor fix in the base follows this same procedure: signed index, per-arch checksums, independent re-hash, no base downgrade, remove the entry once a verified base ships the fix.
- Bookworm-based images remain on the vulnerable `1:1.2.13.dfsg-1`; this record covers only the trixie base this module pins.

## Enforcement

- `services/api-py/tests/test_security_packages.py` fails if the lock lacks a complete per-architecture entry for `zlib1g` or if the checksums do not match the file's schema.
- The `py-image-security` jobs in `.github/workflows/verify.yml` fail on any fixable high/critical runtime finding, which is what this pin removes; `node scripts/verify.mjs` runs both.
