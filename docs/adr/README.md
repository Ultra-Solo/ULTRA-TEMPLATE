# Architecture decision records

Each record captures one decision that shapes this repository: the context that forced it, what was decided, the alternatives rejected, and what it costs. Start a new one from [`0000-template.md`](0000-template.md) with the next free number.

Records are amended, not rewritten. When a decision changes, a new record supersedes or amends the old one, and the old one's status points to it (`Superseded by`, `Amended by`), so the reasoning behind every past state stays readable and no old record reads as current. `scripts/check-docs.mjs` fails a pointer that is missing at either end.

A record states its own status, on its `**Status:**` line. The table below repeats it short, each linked record as its number: `Accepted · Amends [ADR-0006](…)` is `Accepted, amends 0006`. `scripts/check-docs.mjs` fails a row that says anything else, so change the record first and then its row.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-one-required-check.md) | One required check, shared by CI and local runs | Accepted, amended by 0011, 0020 |
| [0003](0003-pin-third-party-code.md) | Pin third-party code by digest | Accepted, amended by 0015, 0017 |
| [0004](0004-independent-modules.md) | Modules are independent and removable | Accepted, amended by 0013, 0014 |
| [0005](0005-layered-services-with-enforced-boundaries.md) | Layered services with enforced boundaries | Accepted, amended by 0010, 0019 |
| [0006](0006-one-set-of-agent-instructions.md) | One set of agent instructions, pointed at by every assistant | Accepted, amended by 0009 |
| [0007](0007-mcp-server-as-an-adapter.md) | Expose the domain to assistants through an MCP adapter | Accepted, amended by 0010 |
| [0008](0008-a-third-language-and-what-a-module-must-prove.md) | A third language, and what any module must prove | Accepted, amended by 0010, 0014 |
| [0009](0009-where-agent-adapters-and-skills-live.md) | Skills stay real files in `.claude/skills/`; every agent adapter is governed | Accepted, amends 0006, amended by 0016 |
| [0010](0010-one-statement-of-the-task-rules.md) | State the task rules once, and hold every copy and the API contract to it | Accepted, amends 0005, 0007, 0008, amended by 0013, 0018 |
| [0011](0011-what-local-verify-guarantees.md) | Hold local verify to CI's toolchain, and name what only CI runs | Accepted, amends 0002, amended by 0014, 0015, 0016, 0017 |
| [0012](0012-lint-and-format-typescript-with-biome.md) | Lint and format the Node modules with Biome | Accepted, amended by 0013 |
| [0013](0013-declare-each-fact-once.md) | Declare each fact once, then derive it or check every copy | Accepted, amends 0004, 0010, 0012, amended by 0018 |
| [0014](0014-modules-describe-themselves.md) | Modules describe themselves in `module.json` | Accepted, amends 0004, 0008, 0011 |
| [0015](0015-one-manifest-for-hand-pinned-tools.md) | Hand-pinned tools live in one manifest | Accepted, amends 0003, 0011, amended by 0017 |
| [0016](0016-cloud-agents-get-the-same-toolchains.md) | Cloud agents get the same toolchains | Accepted, amends 0009, 0011 |
| [0017](0017-prove-the-supply-chain-before-it-runs.md) | Prove every pin before it runs, not where it first runs | Accepted, amends 0003, 0011, 0015 |
| [0018](0018-every-task-service-reads-and-answers-alike.md) | Every task service reads a request and answers it the same way | Accepted, amends 0010, 0013, amended by 0021 |
| [0019](0019-moves-are-compare-and-set-on-the-store.md) | Moves are compare-and-set on the store | Accepted, amends 0005 |
| [0020](0020-require-generated-preset-verification.md) | Require generated preset verification in the template's gate | Accepted, amends 0002, amended by 0022 |
| [0021](0021-bound-request-receive-time.md) | Bound request receive time | Accepted, amends 0018 |
| [0022](0022-advance-the-release-when-generated-output-changes.md) | Advance the release when generated output changes | Accepted, amends 0020 |
