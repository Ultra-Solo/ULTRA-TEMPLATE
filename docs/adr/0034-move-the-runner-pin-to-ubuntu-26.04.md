# ADR-0034: Move the runner pin to Ubuntu 26.04

**Status:** Accepted · Amends [ADR-0029](0029-pin-the-runner-operating-system.md) · **Date:** 2026-10-16

## Context

[ADR-0029](0029-pin-the-runner-operating-system.md) pinned every Linux job to `ubuntu-24.04` and `ubuntu-24.04-arm`, and rejected moving to 26.04 at that time because the image was days old and the gate unvalidated on it: "the image matures while the pin holds 24.04; the move happens later, deliberately, with evidence."

The evidence has since been gathered. The full gate ran green on the explicit `ubuntu-26.04` and `ubuntu-26.04-arm` labels (pull request #54, Oct 15, closed after proving the point): chassis, agent-env, all seven presets, devcontainer-scan, py-image-security on both architectures, zizmor, codeql, security, pins and the Copilot setup steps. Critical-job durations stayed within ±9% of the 24.04 baseline, under the 25% drift threshold this repository set for the move. The two open 26.04 image bugs were assessed against the actual gate: #14790 breaks i386 container networking, and this repository builds amd64 and arm64 only; #14777's RAM-backed `/tmp` holds megabytes of this gate's writes, not the gigabytes that fail.

The maintainer directed the move on Oct 16, ahead of the `ubuntu-latest` flip's scheduled completion (Nov 19, [actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)). Both labels are GA. The flip's timing governs when `ubuntu-latest` becomes 26.04, not when a repository that names its image explicitly may move.

actionlint 1.7.12's runner-label data predates the labels' GA, so the move carries `.github/actionlint.yaml` declaring them — actionlint's supported extension point for labels its data does not know ([rhysd/actionlint#682](https://github.com/rhysd/actionlint/issues/682)).

## Decision

Every Linux job moves to `ubuntu-26.04` (amd64 legs) and `ubuntu-26.04-arm` (arm64 legs) in one release, v3.12.0, ahead of the flip. ADR-0029's discipline stands unchanged: no workflow uses `ubuntu-latest`, the image moves only by hand with the gate validated on the new label first, and `windows-latest` keeps floating until a dated Windows flip is announced. `.github/actionlint.yaml` ships with the move and is removed in a later release when an actionlint release knows the labels natively.

## Alternatives considered

- **Hold until the flip completes Nov 19** — ADR-0029's original timing. The image would mature further, but the gate is already validated on the new label and the maintainer chose not to wait; holding leaves the required gate on an image whose retirement horizon is nearer.
- **Ride `ubuntu-latest`** — rejected by ADR-0029; nothing here reopens it.
- **Move only the required gate** — the pin's value is that every job runs the same image; a split move would put the gate and its helpers on different operating systems.

## Consequences

- CI and every generated project's CI run Ubuntu 26.04 from v3.12.0 on, inside the rollout window rather than after it. Early-adopter flakes, if any arrive, land on a gate that has already proved green.
- The one-shot automation armed for Nov 20 to execute this move when the flip completed is fulfilled by this release; nothing remains to wait for.
- `.github/actionlint.yaml` ships to generated projects and is removed when actionlint's data knows the labels.
- The weekly pins report watches hand-pinned tools, not runner labels (ADR-0029's consequence stands): the next runner move still needs a human reading the announcement.
