# Dev Container scan baseline

The devcontainer security scan ([`.github/workflows/devcontainer-scan.yml`](../.github/workflows/devcontainer-scan.yml)) is report-only: it counts fixable high and critical findings and never fails the build. A number nobody has seen before is still a number nobody can explain, so this page records what the scan found at v3.3.0, and where the findings actually live.

## The record

| Property | Value |
|---|---|
| Source commit | `9b9d3b6` (v3.3.0), verify run 37116451343 |
| Base image | `mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae` |
| Platform | linux/amd64 |
| Scanner | Trivy 0.74.0, the version `scripts/tools/tools.json` pins |
| Dev Container CLI | 0.89.0 |
| Built | 2026-10-03T10:32:43Z |

The evidence artifact (`devcontainer-security-evidence`) is retained for 30 days; this page is the durable record. The run predates the metadata step recording the source commit, scanner version and final image ID, so those values come from the run and the pin.

## What it found

The gate counts **378 fixable high or critical findings**. The full report holds 7473 findings: 28 critical, 519 high, 6347 medium, 578 low, 1 unknown, across the OS packages (Ubuntu 24.04), Node.js, Python, and the Go toolchain and development binaries the image carries.

354 of the 378 — 93.6% — sit in one package: `linux-libc-dev` 6.8.0-85.85, Ubuntu's kernel *headers* (23 critical and 331 high, all fixable upstream). Every Linux kernel CVE is recorded against that package because it ships the kernel's source metadata, and the container runs no kernel of its own; the package is compile-time material, not a running component. The count moves when the base image digest moves (Dependabot's docker entry proposes each new one) and when Ubuntu publishes kernel security updates, so it is noise the gate was designed to report rather than act on.

The remaining 24 spread across real packages: `golang.org/x/mod` (8), `brace-expansion` (4), `golang.org/x/text` (2), `urllib3` (2), `rsync` (2), and one each in `sudo`, `tar`, `undici`, `setuptools`, `ip-address`, `msgpack` and `http-cache-semantics`. These are the findings worth reading when the count jumps: a new one here means a package the image actually runs gained a fixable high or critical vulnerability.

## Reading a change

Compare against this page before acting on a moved count. A jump inside `linux-libc-dev` follows the base image or the Ubuntu archive and needs no response. A jump outside it — or a finding in the Node.js, Python or Go results — is the signal the scan exists to give, and belongs in the pull request that caused it.
