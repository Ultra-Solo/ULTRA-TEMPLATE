# ADR-0051: A generated project's guides name only what the project ships

**Status:** Proposed · Amends [ADR-0050](0050-hold-a-route-claim-to-the-contract.md) · **Date:** 2026-11-07

## Context

`template/init.mjs` takes a preset or an arbitrary set of `--features`, and it keeps a file when any selected feature owns it. It also keeps the prose inside a guide when *no* marker excludes it. Those two rules are not the same rule: a guide is a text file like any other, so a sentence outside a marker survives into a project that dropped the files it names. Nothing compared the two.

Measured over all seven presets and all ten features selected alone — seventeen selections, each generated, marker-processed and compared against the paths its own selection drops — there were twenty findings:

- `go-api` 2, `py-api` 4, `fullstack-ts` 4, `architecture` alone 10; `minimal`, `library`, `mcp`, `all` and every other single feature 0. A finding is one guide naming one absent path, so a single cause can account for several.
- Cause: `architecture/model/views.c4` told every preset that names the assistant about `services/mcp-server`, which none of them ships; the ADR-0049 header comment named `scripts/rules/task-rules.json` in a comment outside every marker.
- Cause: `architecture/README.md` named `scripts/contract/openapi.json` and `template/init.mjs`.
- Cause: `AGENTS.md` named `docs/knowledge/graph.json` and `node scripts/knowledge.mjs sync` from inside the `architecture` block, which selects no `knowledge`.

The repository already generated every one of those projects. `template/init.test.mjs` has two matrices — one over `features.json`'s presets, one over each feature alone — and both ran only `check-hygiene` and `check-docs`, which read the repository's shape and its links, never a sentence against the file list. Every case was green.

Three narrower defects shared the cause:

- The template-only rule was stated at `template/init.test.mjs:360` and implemented at 363 as three hard-coded literals, and `templateOnly` was a different three paths, so the statement and the code disagreed. One literal, `template-release.yml`, is not a tracked file at all — it was deleted in `fb11ffc` — so that third of the check could never fire.
- `viewsSaySomething` in `architecture/rules.mjs` excused itself when the model had no *runtime flows*. A project generated with `architecture` alone has a `product` system with no children and a `dynamic view taskMove` with an empty body, so it had no flows, and the empty view — A diagram that reads as "nothing happens here" — passed all nine rules.
- The first attempt to match a template-only path by its bare word matched `template`, which 105 of the 343 tracked files contain as a substring.

## Decision

A path a generated project does not ship may not appear in a guide it does ship. `template/init.test.mjs` holds it in two functions that both matrices call:

- `absentPaths(manifest, selected)` — the paths some feature owns that the selection does not select. Computed from `template/features.json`, never listed by hand.
- `assertGuidesNameWhatShips(out, selected, label)` — reads every guide that survives the selection (`AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `docs/README.md`, `architecture/README.md`, every `.claude/skills/` file and every `.c4` file the project tracks) and asserts that no absent path appears in it.

A template-only file is matched by its full path (`template/init.mjs`, not the bare word `template`, which 105 of 343 tracked files contain as a substring). The list comes from `git ls-files template/`, so adding a template-only file cannot leave the check behind. The sweep runs over every tracked file of the generated project except the chassis machinery (`scripts/`, `test/`, `data/`, `.github/`, `architecture/`), which legitimately names `template/` while the template exists.

Prose is placed by ownership instead of being rewritten to say less:

- A sentence that is true only where another feature is present goes inside that feature's marker. `AGENTS.md` gains an `architecture&knowledge` block beside the `architecture` block, and the behavioural paragraph in `views.c4` that describes the assistant's local refusal goes inside a bare `mcp-server` marker — bare, not `mcp-server&go-service`, so an MCP server generated over any single service keeps it.
- A sentence that belongs to no feature names no feature-owned path: the `views.c4` header cites ADR-0051 instead of `scripts/rules/task-rules.json`, and `architecture/README.md` says "the contract every task service serves" instead of naming the contract file.

`viewsSaySomething`'s premise is what the product is *made of*, not the flows it happens to have: `productElements(model)` excludes the `product` system itself and everything outside it, and the rule returns nothing only when that set is empty. A model with product contents and no flow still has to fill its view.

## Alternatives considered

- **Declare that `architecture` requires `knowledge` in `template/features.json`** — rejected. The features are independent and removable by design ([ADR-0004](0004-independent-modules.md)), and the selection belongs to the person generating the project. The guide should describe the project that was asked for, not make the generator refuse a selection it already supports.
- **Have the generator drop a line that names an absent path** — rejected. It would rewrite authored prose silently, and a reader of the template could not see what a project would say until they generated one. A marker is visible in review and `applyMarkers` already rejects nesting, so the placement has to be deliberate.
- **Check the prose with a LikeC4 rule** — rejected. Comments are not in the model: `ast` is false and `sourceUri` is undefined, so a rule cannot see them. The rule would have had to read the file as text, which is what `architecture/rules.mjs` is not.
- **Match the bare word `template`** — rejected by measurement: 105 of the 343 tracked files contain it as a substring, and 50 contain `template/`. A guard keyed on the word reports the word, not the file.
- **Leave the three literals and correct the one that is stale** — rejected. The literal list and `templateOnly` would drift again, which is how the stale one got there ([ADR-0013](0013-declare-each-fact-once.md)).

## Consequences

- Twenty findings across the seventeen selections become zero, and the two matrices now fail on the class rather than on a remembered case.
- The second matrix gains the guide rule and the template-only rule it never had, so `--features <id>` alone is held to the same standard as a preset.
- A legitimate cross-feature sentence must be split into markers. That is a real cost: `AGENTS.md` now carries two blocks where it carried one, and a reader of the template has to know that `&` means all of.
- The template-only sweep reads every tracked file of every generated project in both matrices, which is the slowest part of `template/*.test.mjs`.
- `viewsSaySomething` no longer excuses an empty view just because there are no flows: it excuses it only when the product is an empty shell. A project that selects `architecture` alone has such a model, so the rule says nothing there — and a project generated with a product and no flows is a build failure until its view is filled, which is the intent of [ADR-0049](0049-narrate-every-runtime-flow-as-a-dynamic-view.md).
- The rule still reads no sentence about behaviour. It reads the *paths* a guide names; whether a sentence is true of the code is the limitation [ADR-0050](0050-hold-a-route-claim-to-the-contract.md) already states, and this record does not narrow it.

## Enforcement

`template/guides.mjs` holds the guide sweep: `assertGuidesNameWhatShips(out, selected, label, file)` checks one guide, and `assertEveryGuideNamesWhatShips` runs it over every guide a project ships. `template/init.test.mjs` calls the per-file form in the preset matrix's own loop over the guides it keeps, and the full sweep from the feature-alone matrix — "every preset generates a project that passes its own chassis checks and documents only what it has" and "every feature on its own generates a project that passes its chassis checks" — and each fails naming the guide and the path it should not have named. The template-only sweep stays in the preset matrix, driven by `git ls-files template/` instead of three literals, and checks every full `template/...` path in every non-chassis file the project tracks. Restoring `AGENTS.md`, `architecture/README.md` or `architecture/model/views.c4` from before this change makes the preset matrix fail with `go-api: architecture/model/views.c4 names services/mcp-server, which this project does not have`. `architecture/test/model.test.mjs` holds `viewsSaySomething` to its new premise from both sides: an empty `taskMove` fails when the product has contents, and a model whose only element is the `product` system returns nothing. `architecture/rules.mjs` is the only place the rule is written, and `architecture/README.md` names it.