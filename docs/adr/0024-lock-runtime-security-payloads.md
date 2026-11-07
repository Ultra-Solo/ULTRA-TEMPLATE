# ADR-0024: Lock runtime security payloads

**Status:** Accepted · Amends [ADR-0003](0003-pin-third-party-code.md) · Amended by [ADR-0052](0052-refresh-the-runtime-security-lock-when-the-vendor-publishes-a-fix.md) · Date: 2026-10-01

## Context

The Python service's runtime image installs vendor packages that the base image already carries, so a CVE fixed upstream can sit unpatched inside the image for weeks. The image must prove, at build time, exactly which payloads it locks and where each one came from.

## Decision

`services/api-py/security-packages.json` names every security-relevant payload the runtime image locks, with the repository it comes from, the exact version, and the SHA-256 of the `.deb` for each supported architecture. The Dockerfile installs them with `dpkg` from that file, and `services/api-py/tests/test_security_packages.py` fails when a payload is missing an architecture, a checksum, or a repository, or when an architecture the image supports is unknown to the lock.

## Consequences

- A vendor fix lands by editing the lock: new version, new checksums, verified against the vendor's signed package index before the edit is committed.
- CI's `py-image-security` jobs scan the built image and fail on any HIGH or worse finding, so a lock that drifts from the vendor's fixed release blocks the pull request.
- The lock is data, not code: changing it is a one-file diff that review can check line by line.
