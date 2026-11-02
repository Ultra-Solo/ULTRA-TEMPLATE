---
mode: agent
description: Triage a failure or maintenance task into one bounded fix: scan with the knowledge memory, plan one change, apply it only via scripts/search_replace.mjs after a dry run, verify with check-safety and verify.mjs, and report exactly what ran. Ask the human when anything is unclear.
---

The rules for this repository are in [AGENTS.md](../../AGENTS.md); read it first and follow it. Then follow the [triage-and-fix](../../.claude/skills/triage-and-fix/SKILL.md) skill step by step: scan, plan one addressable fix, execute only through `scripts/search_replace.mjs` (dry-run first, then apply), review with `node scripts/check-safety.mjs` and `node scripts/verify.mjs`, and report exactly what ran — including anything that could not run. If a requirement is unclear, ask instead of guessing.
