---
mode: agent
description: Run this repository's local checks and report exactly what ran, what passed, and what could not run.
---

The rules for this repository are in [AGENTS.md](../../AGENTS.md); read it first and follow it. This prompt is the one procedure it asks for most often.

1. Run `node scripts/verify.mjs`. For a change confined to one module, `node scripts/verify.mjs <module>` runs the chassis and that module.
2. Report the summary as it came back: which steps passed, which failed, and and which were skipped by name because a pinned tool or a condition such as cgo is missing here. A missing toolchain or missing dependencies is a failure, not a skip. A step that could not run is a failure to report, not a pass.
3. If something failed, fix the cause rather than the symptom, then run the same command again and report the second result too.
4. Never describe verification you did not perform, and never summarise a red run as green.
