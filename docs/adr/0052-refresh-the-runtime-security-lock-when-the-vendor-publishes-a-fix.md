# ADR-0052: Refresh the runtime security lock when the vendor publishes a fix

**Status:** Proposed · Amends [ADR-0024](0024-lock-runtime-security-payloads.md) · Date: 2026-11-07

## Context

ADR-0024 locks the runtime image's security payloads so a vendor fix cannot sit unpatched, but it does not say what happens between vendor releases: when Debian publishes a fixed `zlib1g` in `trixie-security`, the lock still names the vulnerable version and CI's `py-image-security` jobs fail the pull request until someone notices. The refresh procedure was tribal knowledge — download the payload for every architecture, hash it, compare against the signed index — and nothing recorded that it had been done correctly.

## Decision

When the vendor publishes a fix for a locked payload, refresh the lock in the same pull request that needs it:

1. Take the fixed version from the vendor's signed package index (`dists/<suite>-security/main/binary-<arch>/Packages.xz` over the security repository), never from a mirror's listing alone.
2. Download the `.deb` for every architecture the image supports, compute its SHA-256, and confirm it matches the signed index entry.
3. Update `services/api-py/security-packages.json` with the new version, repository, and per-architecture checksums, and update the count in `services/api-py/tests/test_security_packages.py` when the number of locked packages changes.
4. Record the refresh as an ADR that amends ADR-0024, so the decision log shows why the lock moved.

## Consequences

- A CVE in a locked payload has a mechanical path to green CI: refresh the lock, verify checksums against the signed index, and the `py-image-security` scan passes.
- Every refresh is auditable: the ADR names the CVE, the old and new versions, and the checksums came from a signed source.
- The lock stays data: the refresh changes only `security-packages.json`, its test, and the ADR record.

## Enforcement

`services/api-py/tests/test_security_packages.py` fails when a locked payload lacks an architecture, a checksum, or a repository, and the `py-image-security` jobs in `.github/workflows/verify.yml` scan the built amd64 and arm64 images and fail on any HIGH or worse finding, so a lock that names a vulnerable payload version blocks the pull request.
