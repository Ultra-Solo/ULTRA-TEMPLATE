---
name: consult-knowledge
description: Ask the repository's memory what is already decided, what depends on what, and what went wrong before, using the offline graph in docs/knowledge. Use before a structural change, when asked why something is built a certain way, or when unsure which files a change touches.
---

# Consult the memory

1. Read `docs/knowledge/README.md` (the briefing). It is generated and under 8 KB.
2. Ask a question: `node scripts/knowledge.mjs query "<question>" --budget 1500`. Results are ordered L2 (extracted from the checkout), then L4 (episodes people wrote), then L3 (inferred, labelled so); trust them in that order.
3. Trace a relationship with `path <from> <to>`, or read one node and its neighbours with `explain <id>`. Node ids look like `adr:0017`, `doc:docs/README.md`, `script:scripts/verify.mjs`.
4. Open the file a result cites before relying on it. The graph points at sources; it does not replace them.
5. If the answer contradicts the files, the files win: run `node scripts/knowledge.mjs sync`, then say what changed.
6. A lesson worth keeping is not written by you. Suggest an episode to a person; `record-episode` says how.
