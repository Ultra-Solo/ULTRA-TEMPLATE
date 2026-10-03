# ADR-0026: Remap the foundation milestones to versions

**Status:** Accepted · Amends [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) · **Date:** 2026-10-03

## Context

[ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) mapped two releases: v3.3.0 carrying the whole foundation repair (A1–A5), v3.4.0 carrying the run/diagnose/maintain work (B1–B4). What actually happened:

- v3.3.0 shipped **A1 only**: the devcontainer scan made conditional on feature selection and moved inside the verify gate, exercising the container lifecycle and running every module's checks in-container. The first in-container run exposed a real gap (the base image ships without Graphviz, which the architecture build needs), fixed in the same release.
- The first post-merge in-container verify on main (run 37116451343) then **failed on a defect no local run could reproduce**: `check-contract` runs its configuration cases in a concurrent pool, and a Linux kernel reissues a just-freed ephemeral port to the next `bind(0)`, so two workers could be handed the same port and the service binding second exited with `EADDRINUSE` — an estimated 3–4% of runs. Windows and this WSL kernel could not show it; the container did. The fix gives each case its own port slot below the ephemeral range, where the kernel never allocates.
- **A2, A4 and A5 remain open**: build evidence still hardcodes the base pin and records an empty digest for the locally built image; publication still triggers on the merge push rather than on verify's result; the 378 findings are still untriaged.
- **A3 is unstarted**, and the regex import checkers it meant to replace state their own trade-off in source: they read every import written as a string, may false-alarm on import-shaped comments, and the only residual gap is a computed import specifier — which has no legitimate use below a composition root in this codebase.
- **B1–B4 are unstarted.**

## Decision

- **v3.4.0 closes ADR-0025's remaining foundation ledger**: A2r (build evidence derived from the Dockerfile and the built image), A4r (publication gated on the verify workflow's success for the exact commit it verified), A5 (the scan baseline recorded and triaged in `docs/devcontainer-scan-baseline.md`), and the port-slot fix the first in-container run exposed.
- **B1–B4 move to v3.5.0**, unchanged in content.
- **A3 is dropped from the plan.** The checkers' regex misses no import written as a string; a parser rewrite would put a parser dependency in every generated project's zero-dependency checker against a theoretical gap. If a computed-import bypass ever appears, reproduce it, then fix it — the convention the repository already states.

## Alternatives considered

- **Ship B1–B4 as v3.4.0 anyway, keeping ADR-0025's map** — Rejected: publication would stay ungated and the scan evidence unrecorded while the first in-container run had just proven the foundation catches real defects; capability work on top of open foundation gaps compounds exactly what ADR-0025 said to avoid.
- **Fold A2r, A4r and A5 into v3.3.x patch releases** — Rejected: they change generated output (the workflows ship in presets) and documentation, which is feature work; a patch carries fixes only.
- **Keep A3 in v3.4.0** — Rejected: no computed-import bypass has been demonstrated in this codebase, and the cost is real — a parser dependency in checkers that today run with none.

## Consequences

- **Easier**: v3.4.0 is a small, reviewable release that closes the foundation ledger; what the template claims about verification and evidence matches what it does; v3.5.0's scope is already defined by ADR-0025's B1–B4.
- **Harder, or costs**: the run/diagnose/maintain work waits one release; A3's residual risk — a computed import specifier below a composition root — is accepted and recorded here rather than engineered away.
- The first in-container verify has already paid for A1: it caught a port-allocation race that no local run on any available kernel could reproduce.
