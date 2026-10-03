# ADR-0025: Prioritize verified foundation before capability expansion

**Status:** Accepted · Amended by [ADR-0026](0026-remap-the-foundation-milestones-to-versions.md) · **Date:** 2026-10-02

## Context

PR #22 (v3.2.0) added a devcontainer security scan but introduced four P1 defects that break generated projects and misrepresent guarantees:

1. **R1** — Generated projects without devcontainer retain an unconditional scan job that fails (security.yml line 159 adds devcontainer-scan outside feature markers)
2. **R2** — The scan job lives in a separate workflow outside the required `verify` gate; a scan failure can coexist with a passing required check
3. **R3** — The installer script hash is verified but the script downloads Node and CLI tarballs without payload verification; the tool registry entry has no platform checksums
4. **R4** — Image evidence relies on RepoDigests for a local image and duplicates a base pin literal instead of deriving from build evidence

Additionally, the JS/TS boundary checkers have demonstrated false negatives (computed imports bypass regex-only analysis), and the release workflow publishes independently of main verify success.

The review concluded that expanding capabilities (databases, auth, deployment, MCP HTTP, telemetry) before fixing these foundation issues would compound technical debt and mislead adopters.

## Decision

Ship **v3.3.0 — verified foundation** first, then **v3.4.0 — run, diagnose and maintain**. Do not expand the default product stack (databases, authentication, deployment, queues, extra UI frameworks) in either release.

### v3.3.0 scope (Milestone A)
- **A1**: Make devcontainer workflow content and verify dependencies conditional on actual feature selection using template markers; move scan into verify via reusable workflow; build/scanner failures must fail verify; exercise lifecycle setup and module verification inside the built environment
- **A2**: Use repository-selected Node runtime with integrity-enforced CLI installation; verify artifacts before extraction; add reviewed Feature lock inputs; derive base-image evidence from build/configuration; retain structured local image ID, OS/arch, registry digests, Feature identities, source SHA, scanner metadata, full scan output/SBOM
- **A3**: Replace regex-only import extraction with parser-backed analysis in API TypeScript, MCP, and web; define policy for computed dynamic imports (reject unless explicitly permitted)
- **A4**: Bind publication to successful trusted verify result for the exact main commit; restrict release write permissions; handle concurrent runs and existing releases idempotently
- **A5**: Triage the 378 HIGH/CRITICAL findings from the current scan baseline; classify by component ownership, fixed-version availability, and practical remediation; document baseline/disposition and honest residual-risk statement

### v3.4.0 scope (Milestone B)
- **B1**: One-command local development runner for selected modules (web + explicit API choice); bounded readiness checks, prefixed logs, reliable child-process cleanup
- **B2**: Real browser-to-API smoke test (Chromium, TypeScript API + web); create/change/reload task journey; controlled API error and keyboard interaction; isolated data, unique ports, traces on failure
- **B3**: Read-only doctor with versioned JSON output; reuse existing tool/module/source records; distinguish pass/fail/unknown/not-applicable; no project writes
- **B4**: Check-only update discovery extending exact-source updater; compare recorded source with verified release; JSON output for future automation; no renderer execution

## Alternatives considered

- **Expand capabilities first (databases, auth, deployment)** — Rejected: changes declared scope, introduces credentials/migrations/larger support matrix, compounds existing verification gaps
- **Replace generator with Copier** — Rejected: migration and provenance compatibility costs without demonstrated missing core primitive; retain current generator, adopt useful discovery patterns
- **Add MCP HTTP, prompts/resources, telemetry now** — Rejected: does not repair current adoption or verification gaps; revisit after capability release
- **Single large release with all capabilities** — Rejected: harder review, longer feedback loop, coupled failures; use two bounded releases

## Consequences

- **Easier**: Adopters get trustworthy generated projects; verification guarantees match reality; update discovery works without executing untrusted code; browser smoke proves real integration
- **Harder/Costs**: Requires disciplined CI and process-lifecycle work; parser selection may add module coupling (must resolve before weakening enforcement); browser tests need isolation/readiness investment; dev runner must not require root workspace migration
- **Deferred**: Database/auth/deployment profiles need separate scope decision and maintained upgrade/testing ownership; opt-in draft update PR automation deferred until discovery proves useful; generated clients only if they reduce measured contract-maintenance work