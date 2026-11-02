# ADR-0038: Keep a layered, self-checking memory of the repository in docs/knowledge

**Status:** Accepted · **Date:** 2026-11-02

## Context

Decisions, lessons and the shape of the system live in ADRs, docs, workflows and scripts. An assistant or a new contributor re-derives them every session, and a note written once goes stale without anything saying so. Generated knowledge graphs exist (graphify among them), but one that depends on an LLM, a Python install or a key cannot be a gate, and one a bot rewrites cannot be audited. The template also needs every preset, `minimal` included, to start with the same memory.

## Decision

Add the `knowledge` feature to every preset. `docs/knowledge/` holds five layers:

- **L0** `README.md`: a generated briefing under 8 KB.
- **L1** the ADRs, docs and decision log that already exist; nothing is duplicated.
- **L2** `graph.json`: nodes and edges extracted by pure per-file functions in `scripts/knowledge/core.mjs` from files in the checkout. Output is sorted and byte-identical for the same inputs, with no clock, network or dependency.
- **L3** `semantic.graph.json`: optional, from `import-graphify`. Reduced to a fixed field set, stripped of invisible characters, limited to relative paths, sealed with a content hash, labelled `llm-inferred`, ranked below L2 and never required. Stale sources warn rather than fail.
- **L4** `episodes/`: lessons, incidents and decisions a person writes, each with `reviewBy` and the nodes it is about. No command or agent writes one. A committed episode may not be edited or deleted; a correction supersedes it, and a superseded episode may still name what has since been renamed or removed. The optional pre-commit hook refuses to run when a graph source is not fully staged, because `sync` reads the working tree and the commit would otherwise carry a graph it cannot reproduce.

`node scripts/knowledge.mjs sync` regenerates L0 and L2; `check` runs in `verify` and fails on a stale or missing generated file, a source with no node, a dangling episode reference, a broken seal, or a changed episode. "Incremental" means pure per-file extractors and a deterministic rebuild that takes milliseconds, with per-source fragment hashes that name what drifted; there is no cache to go wrong. Hashes cover extracted structure, so a pin bump leaves the graph unchanged. An opt-in hook runs `sync` before a commit; CI `check` is the gate.

## Alternatives considered

- **graphify as the engine** — needs Python and, for docs, an LLM; its output is probabilistic, so it cannot gate. It is kept as an optional L3 producer.
- **A bot or agent that commits updates** — adds a write path to the repository nobody reviews.
- **An agent-written episode log** — mixes unreviewed text into what is trusted as memory.
- **A vector store** — a service to run and a result that changes between runs, for a corpus a token-budgeted graph query serves.
- **A real incremental cache** — more state to invalidate, for a rebuild that is already fast.

## Consequences

- Every generated project starts with a queryable, checked memory and two skills for using and extending it.
- `verify` gains a step, and a change to docs, scripts, workflows or modules needs a `sync` committed with it.
- The immutability check compares against HEAD or `KNOWLEDGE_BASE_REF`; in a pull request's merge commit it sees nothing unless that variable names the base, so review remains the control there.
- Marker blocks are not extracted: generated projects strip them.
- L3 stores the SHA-256 of its sources, so a doc edit raises a warning until the import is rerun.
