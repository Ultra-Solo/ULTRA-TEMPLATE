# ADR-0029: Pin the runner operating system in every workflow

**Status:** Accepted · **Date:** 2026-10-06

## Context

GitHub announced that the `ubuntu-latest` label flips to Ubuntu 26.04, rolling out from October 19 to November 19, 2026 ([actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)). This repository pins actions by commit SHA, hand-pinned tools by SHA-256 checksum, container images by digest and toolchain versions in version files — yet 36 `runs-on: ubuntu-latest` references across 13 workflows rode a floating label, including the required `verify` gate.

The browser smoke test ([ADR-0028](0028-run-the-browser-smoke-test-through-the-e2e-slot.md)) made the dependence concrete: it launches the pinned Playwright Chromium, whose OS libraries the runner image ships. The same release proved the gap is real — the identical browser failed in the Dev Container because its base image lacks those libraries. A runner image that changes underneath the gate makes verification nondeterministic by calendar date: two runs days apart can run different operating systems, and a release attempt can fail on an OS nobody chose.

The arm64 matrix legs were already pinned to `ubuntu-24.04-arm`; the amd64 legs floating was an inconsistency, not a choice.

## Decision

Every Linux job in every workflow names its runner image explicitly: `ubuntu-24.04` for amd64 legs, `ubuntu-24.04-arm` for arm64 legs. No workflow uses `ubuntu-latest`.

The runner image moves only by hand, like any other pin: read the new image's announcement, validate the full gate on the explicit new label (`ubuntu-26.04` is already usable for that), move the pin in one release, and say so in the release notes.

The Windows chassis job keeps `windows-latest` until GitHub announces an equivalent dated flip for it; the same procedure applies then.

## Alternatives considered

- **Ride `ubuntu-latest` through the flip** — no work now, but the one unpinned dependency would stay unpinned through a known, dated breaking change, and the browser smoke's dependence on image-shipped libraries is exactly the kind of gap that surfaces that way.
- **Validate on `ubuntu-26.04` now and pin directly to it** — the label is already usable and Playwright 1.63.0's Ubuntu 26.04 package list is identical to 24.04's, but validating the whole gate on a weeks-old image inside the same change that moves the pin is a bigger bite, and early-adopter flakes would land in the required gate. The image matures while the pin holds 24.04; the move happens later, deliberately, with evidence.
- **Pin the Windows leg too** — no dated flip is announced for `windows-latest`; pinning it now would be speculative.

## Consequences

- The gate runs the same operating system on every day of the rollout window; a release attempt cannot fail because GitHub moved a label.
- Generated projects inherit the pin, so their CI is insulated from the flip too, and moves when they take a template update that moves the pin.
- Moving to Ubuntu 26.04 becomes a deliberate release with its own validation, not something that happens to the gate one morning.
- The pin must be moved by hand eventually — Ubuntu 24.04's runner image will age and retire, and the weekly pins report watches hand-pinned tools, not runner labels, so a maintainer has to read that announcement.
- The Windows chassis job still floats; a Windows flip would arrive unannounced by this repository's own checks.
