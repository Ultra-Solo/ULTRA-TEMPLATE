# ADR-0039: Port only verifiable mechanisms from external self-improving engines

**Status:** Accepted · **Date:** 2026-11-02

## Context

An external "self-improving autonomous maintenance engine" (mayo) was reviewed in full: a webhook-driven bot whose loop is scan → plan → LLM-generated JSON edits → review phases → append-only audit log, with a global memory that decays, proactive cron phases, an HMAC-verified webhook receiver, and an OPEN_ISSUE escape hatch for unclear requirements. Its mechanism is unverifiable: the edit matcher is an LLM, the loop can rewrite itself, and nothing in it can gate a build. ADR-0037 already bounds this repository's own self-upgrade gate for exactly that reason, and ADR-0038 keeps the memory human-written and immutable. When an external engine is mined for ideas, something has to say which of its parts may cross into this template and which may not.

## Decision

- Port from an external self-improving engine only mechanisms that are **deterministic and verifiable by a check**: exact-match surgical edits with a catastrophic guard, diff-measured mutation caps, schema-validated bounded plans, machine-checked layered memory, and a written standing plan with trigger thresholds.
- Agent roles (scanner, executor, reviewer) cross as **human-operated skills and prompts**: the human triggers the run and gives the final approval; the executor applies edits only through `scripts/search_replace.mjs` (dry-run first); the reviewer's verdict is mechanical (`verify` + `check-safety`) plus human review.
- The escape hatch crosses as a rule: **when requirements are unclear, ask** (`ask_user`, or open an issue) — never a guessed edit.
- Anything autonomous — a bot that commits, a webhook receiver that triggers edits, LLM-written memory, a self-modifying loop, model fallback inside gate code — does **not** cross as code. It may be proposed only as a dated backlog row with named evidence conditions, decided at a cadence check.
- Every port lands as an ordinary pull request under the normal gates (check-safety caps, the plan-gated self-upgrade, `verify`), with an ADR and a failing test first, in the same pull request as the change.

## Alternatives considered

- **Running the external loop inside this repository as a bot** — an unverifiable write path to the repository; ADR-0037 and ADR-0038 already rejected the equivalent for this repo's own gate and memory.
- **Porting its LLM matcher verbatim** — nondeterministic; `search_replace.mjs`'s exact five-pass matcher with a catastrophic guard replaces it (ADR-0037).
- **Porting everything at once** — unverifiable blast radius; each mechanism crosses alone, with its own test and its own release.
- **Ignoring external engines entirely** — loses patterns that proved sound and cost nothing to state deterministically: bounded edit blocks, separation of scanner/executor/reviewer, the ask-don't-guess rule.

## Consequences

- The contiguous-block cap in `scripts/check-safety.mjs` and the `triage-and-fix` skill shipped in v3.17.0 are this ADR's first applications.
- Future reviews of external engines start from this rule instead of re-deriving it.
- A bot or any other autonomous write path remains possible only through a dated backlog decision with named evidence (adopter demand, an owner), never ad hoc.
