# ADR-0024: Lock runtime security payloads

**Status:** Accepted · Amends [ADR-0003](0003-pin-third-party-code.md) · **Date:** 2026-10-01

## Context

The pinned Python base contained seven fixable high/critical package occurrences covering three vendor CVEs. Refreshing its multi-platform index did not change the amd64 or arm64 child images. A disposable package update removed those findings, but an apt update against changing indexes did not identify repeatable build inputs. Existing image scans were report-only and discarded complete per-image results.

## Decision

- Keep the existing digest-pinned base and lock the four Debian security packages in the Python module's `security-packages.json`. Each package has one fixed version and an exact official HTTPS pool path and SHA-256 for every architecture in the base. Obtain checksums from vendor indexes verified with Debian's archive keyring, review advisories, then verify downloaded payload identity independently.
- Download with TLS verification, a timeout and size bound. Verify every checksum, package name, version and architecture before the first dpkg installation; verify installed versions afterward. Do not use changing apt indexes in the Docker build or downgrade a newer pinned base. A new base with newer packages requires refreshing or removing the temporary patch lock.
- Keep payloads and the installer out of the final filesystem. An optional public CA build secret supports managed proxies without adding session trust material to image layers. The runtime keeps its non-root user, removes pip and retains no Python application dependencies.
- A required `py-image-security` matrix runs on native amd64 and arm64 hosts. Build and exercise the complete HTTP contract, receive deadlines, startup defaults and graceful shutdown; retain full Trivy JSON reports and reject fixable high/critical runtime findings using the existing ignore policy. Feed both results into `verify`. Initialization removes the job when the Python feature is absent.
- The broader security workflow still reports development-container and other image findings. This change does not claim the complete development environment or every CPU runtime has been audited. Artifact identity is verified for all eight base architectures; native runtime and scan checks cover amd64 and arm64.

## Alternatives considered

- **Only refresh the Python tag's index digest** — its relevant child images were unchanged.
- **Run apt update during each build** — package selection and indexes change; exact input bytes would not be recorded.
- **Wait for a rebuilt official Python base** — fixes are available now. Remove this bounded patch when a verified vendor base makes it redundant.
- **Commit all binary packages or publish a custom base** — adds artifact hosting and maintenance that this repair does not need.
- **Gate every historical devcontainer finding immediately** — requires separate exposure and remediation work; that image has a different baseline.

## Consequences

- The build uses repeatable package payloads, without installing unverified bytes. This is input reproducibility, not a promise of byte-identical OCI images: package scripts and image metadata can contain timestamps.
- Removed or changed vendor pool files fail the build. Refresh locks from signed vendor metadata, or choose a verified fixed base; never substitute an unchecked download. Hashes protect recorded bytes and do not independently authenticate a publisher.
- Python image findings are now actionable failures on the two native platforms, and complete scan evidence survives in CI artifacts. Scanner/database failures fail separately from findings. Remaining lower-severity or unfixed findings are visible in the full report.
