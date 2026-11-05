# Architecture decision records

Each record captures one decision that shapes this repository: the context that forced it, what was decided, the alternatives rejected, and what it costs. Start a new one from [`0000-template.md`](0000-template.md) with the next free number.

Records are amended, not rewritten. When a decision changes, a new record supersedes or amends the old one, and the old one's status points to it (`Superseded by`, `Amended by`), so the reasoning behind every past state stays readable and no old record reads as current. `scripts/check-docs.mjs` fails a pointer that is missing at either end.

A record states its own status, on its `**Status:**` line — `Proposed`, `Accepted`, `Deprecated`, `Rejected`, or `Superseded by` a later record. The table below repeats it short, each linked record as its number: `Accepted · Amends [ADR-0006](…)` is `Accepted, amends 0006`. `scripts/check-docs.mjs` fails a row that says anything else, so change the record first and then its row.

From ADR-0042 on, every record also carries an `## Enforcement` section naming the check or test that fails when the decision is undone; `scripts/check-docs.mjs` fails a record without one.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-one-required-check.md) | One required check, shared by CI and local runs | Accepted, amended by 0011, 0020 |
| [0003](0003-pin-third-party-code.md) | Pin third-party code by digest | Accepted, amended by 0015, 0017, amended by 0024 |
| [0004](0004-independent-modules.md) | Modules are independent and removable | Accepted, amended by 0013, 0014 |
| [0005](0005-layered-services-with-enforced-boundaries.md) | Layered services with enforced boundaries | Accepted, amended by 0010, 0019 |
| [0006](0006-one-set-of-agent-instructions.md) | One set of agent instructions, pointed at by every assistant | Accepted, amended by 0009 |
| [0007](0007-mcp-server-as-an-adapter.md) | Expose the domain to assistants through an MCP adapter | Accepted, amended by 0010, 0030 |
| [0008](0008-a-third-language-and-what-a-module-must-prove.md) | A third language, and what any module must prove | Accepted, amended by 0010, 0014 |
| [0009](0009-where-agent-adapters-and-skills-live.md) | Skills stay real files in `.claude/skills/`; every agent adapter is governed | Accepted, amends 0006, amended by 0016 |
| [0010](0010-one-statement-of-the-task-rules.md) | State the task rules once, and hold every copy and the API contract to it | Accepted, amends 0005, 0007, 0008, amended by 0013, 0018 |
| [0011](0011-what-local-verify-guarantees.md) | Hold local verify to CI's toolchain, and name what only CI runs | Accepted, amends 0002, amended by 0014, 0015, 0016, 0017 |
| [0012](0012-lint-and-format-typescript-with-biome.md) | Lint and format the Node modules with Biome | Accepted, amended by 0013 |
| [0013](0013-declare-each-fact-once.md) | Declare each fact once, then derive it or check every copy | Accepted, amends 0004, 0010, 0012, amended by 0018 |
| [0014](0014-modules-describe-themselves.md) | Modules describe themselves in `module.json` | Accepted, amends 0004, 0008, 0011, amended by 0027 |
| [0015](0015-one-manifest-for-hand-pinned-tools.md) | Hand-pinned tools live in one manifest | Accepted, amends 0003, 0011, amended by 0017 |
| [0016](0016-cloud-agents-get-the-same-toolchains.md) | Cloud agents get the same toolchains | Accepted, amends 0009, 0011 |
| [0017](0017-prove-the-supply-chain-before-it-runs.md) | Prove every pin before it runs, not where it first runs | Accepted, amends 0003, 0011, 0015, amended by 0041 |
| [0018](0018-every-task-service-reads-and-answers-alike.md) | Every task service reads a request and answers it the same way | Accepted, amends 0010, 0013, amended by 0021, 0036 |
| [0019](0019-moves-are-compare-and-set-on-the-store.md) | Moves are compare-and-set on the store | Accepted, amends 0005 |
| [0020](0020-require-generated-preset-verification.md) | Require generated preset verification in the template's gate | Accepted, amends 0002, amended by 0022 |
| [0021](0021-bound-request-receive-time.md) | Bound request receive time | Accepted, amends 0018 |
| [0022](0022-advance-the-release-when-generated-output-changes.md) | Advance the release when generated output changes | Accepted, amends 0020, amended by 0023, superseded by 0041 |
| [0023](0023-reconstruct-projects-from-exact-source.md) | Reconstruct projects from exact source | Accepted, amends 0022, amended by 0041 |
| [0024](0024-lock-runtime-security-payloads.md) | Lock runtime security payloads | Accepted, amends 0003 |
| [0025](0025-prioritize-verified-foundation-before-capability-expansion.md) | Prioritize verified foundation before capability expansion | Accepted, amended by 0026 |
| [0026](0026-remap-the-foundation-milestones-to-versions.md) | Remap the foundation milestones to versions | Accepted, amends 0025, amended by 0027 |
| [0027](0027-ship-run-and-diagnose-before-the-browser-smoke-test.md) | Ship run and diagnose before the browser smoke test | Accepted, amends 0026, 0014, amended by 0028 |
| [0028](0028-run-the-browser-smoke-test-through-the-e2e-slot.md) | Run the browser smoke test through the e2e slot | Accepted, amends 0027 |
| [0029](0029-pin-the-runner-operating-system.md) | Pin the runner operating system in every workflow | Accepted, amended by 0034 |
| [0030](0030-serve-mcp-over-streamable-http-beside-stdio.md) | Serve MCP over Streamable HTTP beside stdio | Accepted, amends 0007 |
| [0031](0031-track-the-node-lts-line.md) | Track the Node LTS line | Accepted |
| [0032](0032-track-the-current-stable-go-line.md) | Track the current stable Go line | Accepted |
| [0033](0033-track-the-current-stable-python-line.md) | Track the current stable Python line | Accepted |
| [0034](0034-move-the-runner-pin-to-ubuntu-26.04.md) | Move the runner pin to Ubuntu 26.04 | Accepted, amends 0029 |
| [0035](0035-drive-releases-from-a-written-standing-plan.md) | Drive releases from a written standing plan | Accepted, superseded by 0041 |
| [0036](0036-record-what-the-task-contract-leaves-free.md) | Record what the task contract leaves free | Accepted, amends 0018 |
| [0037](0037-bound-the-self-upgrade-gate-to-a-validated-plan.md) | Bound the self-upgrade gate to a validated plan | Accepted, amends 0011, 0020 |
| [0038](0038-keep-a-layered-self-checking-memory-in-docs-knowledge.md) | Keep a layered, self-checking memory in docs/knowledge | Accepted |
| [0039](0039-port-only-verifiable-mechanisms-from-external-engines.md) | Port only verifiable mechanisms from external engines | Accepted |
| [0040](0040-clean-generated-projects-of-template-meta-history.md) | Clean a generated project of the template's meta-history at generation time | Accepted, amended by 0041 |
| [0041](0041-remove-template-self-versioning.md) | Remove the template's self-versioning; address a template by commit | Accepted, amends 0017, 0023, 0040, supersedes 0022, 0035 |
| [0042](0042-make-every-adr-falsifiable.md) | Make every ADR falsifiable: a full status grammar and a required Enforcement section | Accepted |
| [0043](0043-rules-ship-failing-cases.md) | Every architecture rule ships a failing case; a structural PR carries the whole set | Accepted |
| [0044](0044-model-the-repositorys-own-machinery.md) | Model the repository's own machinery in the architecture model | Accepted, amended by 0048 |
| [0045](0045-no-orphan-elements.md) | No element floats without a relationship | Accepted |
| [0046](0046-draw-every-chassis-script-in-the-model.md) | Draw every chassis script in the architecture model | Accepted, amended by 0047 |
| [0047](0047-draw-every-workflow-and-scripts-file-in-the-model.md) | Draw every workflow and every scripts/ file in the architecture model | Accepted, amends 0046, amended by 0048 |
| [0048](0048-draw-every-tracked-file-outside-the-modules-in-the-model.md) | Draw every tracked file outside the modules in the architecture model | Proposed, amends 0044, amends 0047 |
