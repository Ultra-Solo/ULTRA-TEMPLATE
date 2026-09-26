# How the template works

Everything in `template/` is deleted when a project is initialized. This file is for whoever maintains ULTRA-TEMPLATE itself.

## Why initialization is a local script

GitHub's *Use this template* copies every file and accepts no parameters, so feature selection has to happen after the copy. It cannot run as a GitHub Actions job in the new repository: a push made with `GITHUB_TOKEN` may not create, change or delete anything under `.github/workflows/`, and initialization does all three. So `template/init.mjs` runs once, on the developer's machine, and the result is committed as one reviewable change.

It has no dependencies beyond Node <!-- generated:version .node-version -->24<!-- /generated -->, validates every argument before touching a file, builds the whole result in memory before writing any of it, and refuses to run in place on a dirty working tree, so `git checkout -- . && git clean -fd` always undoes it.

## The three mechanisms

**Feature paths.** `features.json` lists, for each feature, the paths it owns. Paths of unselected features are deleted, and so is every `templateOnly` path.

Several features may own the same path, which then belongs to any of them and is deleted only when none is selected — the three task services share `scripts/check-contract.mjs` and its test that way, and every module that states the task rules shares `scripts/rules`. A path *inside* another feature's path is rejected instead: the two disagree about a file, and it would be kept or deleted by whichever path init processed last rather than by the selection. One module directory still has one owner, and a test holds it to that.

**Marker blocks.** Content inside shared files — workflows, Dependabot, the README, the architecture model — is selected with a pair of marker lines. A marker is the text `ultra:begin` or `ultra:end` followed by a feature id, written inside whatever comment syntax the file uses:

```text
# ultra:begin FEATURE          (YAML, .gitignore)
<!-- ultra:begin FEATURE -->   (Markdown)
// ultra:begin FEATURE         (JSONC, LikeC4, TypeScript)
```

(`FEATURE` is written in capitals here so this page contains no real marker.) The keyword is `ultra`, fixed by the grammar and unchanged by what the repository is called; no initialized project contains one. When the feature is selected, the marker lines are deleted and the content between them is kept; otherwise both go. The id `template` is reserved and always removed. Blocks cannot nest, and an unknown id, an unclosed block or a mismatched end stops init before any file is written. After initialization `scripts/check-hygiene.mjs` fails if a marker line survives.

**Any of several features.** An id may join features with `|` — `FEATURE-A|FEATURE-B` — for content that belongs to a project with any one of them. The end marker names the same ids in the same order, so a half-edited pair is an error rather than a guess, and `template` cannot be joined to a feature. `AGENTS.md`'s paragraph on the task API contract is written this way: it belongs to a project with a Go, TypeScript or Python service, and to no other.

**All of several features.** An id may instead join features with `&` — `FEATURE-A&FEATURE-B` — for content that needs every one of them, such as a relation between two modules. The architecture model draws the MCP server's and the web app's calls to each task service this way, so a project keeps the arrow only when it keeps both ends. One id cannot mix `|` and `&`; content that needs a mix is two blocks.

Strict JSON has no comments, so JSON files carry no markers; a feature that needs a JSON file owns the whole file as a path.

A marker is a whole line, and in Markdown it is an HTML comment, which ends a table and splits a paragraph. So a block is whole lines that already stand alone — a paragraph, a list item, a fenced block — never a row of a table or a sentence inside a paragraph. A path, not a marker, is how a whole file is made conditional.

**Identity.** The template is a working project under a real identity — owner `hynix666`, repository `ULTRA-TEMPLATE`, name `ultra-template` — so it verifies green before anyone initializes it. Init replaces those three strings in every text file, through placeholders so no replacement can rewrite another's output. Never write them in a form that should survive initialization.

The three are not interchangeable, and the public contract says where each one lands. `--owner` and `--repo` are the GitHub repository: every link, every badge, and the README title, which is what a reader sees at the top of that repository. `--name` is the project: `package.json` names and the npm scope, which is `@owner/name` lowercased because npm rejects capitals. They differ whenever a repository is named for its deployment and the package for its import, so neither may stand in for the other.

## Adding a feature

1. **Create the module directory, self-contained:** its toolchain's manifest and lockfile, tests, a README, and a `module.json` saying what it is: its id (the feature's), its toolchain, the checks `verify` runs, and, where they apply, `coverage`, `taskApi`, `facts`, `e2e` and `image` ([ADR-0014](../docs/adr/0014-modules-describe-themselves.md)). `scripts/modules.mjs` finds the module by that file, and setup, verify, the contract, the facts check and CI all read it; `check-hygiene` fails a malformed one. A Node module's `biome.jsonc` extends the root one, its `verify` script starts with `npm run lint`, and its coverage writes `coverage/lcov.info`.
2. **Add the feature to `features.json`** with the paths it owns, and to the presets it belongs in. The template tests fail if a module is not owned by exactly one feature.
3. **Add its job to `.github/workflows/verify.yml`,** named after its id — a checkout, then `.github/actions/module` with that id — inside a marker block, and list it under `verify.needs` inside another. `check-hygiene` fails if the job is missing, named otherwise, or left out of the gate. The action reads the module's toolchain from its `module.json`, so no other workflow needs an edit, `template-test.yml` and `copilot-setup-steps.yml` included.
4. **Add its lines elsewhere,** each inside markers: its Dependabot entries, its lines in `README.md` and `AGENTS.md`, and its element in the architecture model, linking its README, with a relation to another module in an `a&b` block. `check-hygiene` fails if its Dependabot entry is missing, and `check-architecture` if its element is. A task service says how it starts under `taskApi` and must pass the contract, configuration cases included; a module that repeats a fact lists it under `facts` and prints it from a `facts` script; a client of the task API can declare an `e2e` check. Any of them owns `scripts/rules` in `features.json`, and `scripts/contract` too if it serves or calls the task API.
5. **Where its README restates a fact** — a port, a limit, a version — write a generated block instead of the value (`scripts/generate-docs.mjs`).
6. **Verify,** as described below. A new preset needs no workflow edit: `template-test.yml` reads the presets from `features.json`.

## Verifying a change to the template

```bash
node scripts/verify.mjs                          # the template as a project, every feature present
node template/init.mjs --preset minimal --name demo-app --owner octo-org --out ../demo-minimal
cd ../demo-minimal && git init -q && git add -A && node scripts/setup.mjs && node scripts/verify.mjs
```

`template/init.test.mjs` checks the marker grammar, identity replacement, argument validation, that the manifest matches the tree, and that an initialized project has no template residue. `.github/workflows/template-test.yml` generates every preset in CI and runs each project's own `setup` and `verify`, which lints its workflows with the pinned actionlint and zizmor.

## Scope

ULTRA-TEMPLATE 1.x is complete in scope. It gives a project the things with no product opinion — one verification gate, a pinned supply chain, repository and documentation checks, agent guidance, releases, security scanning, and a set of services and packages that demonstrate one architecture in three languages. A change belongs in the template when it would be right for nearly every project made from it.

These stay decisions for each project, and are left out on purpose: deployment targets and infrastructure, databases and migrations, authentication, message queues, UI frameworks beyond the minimal React app, and desktop or mobile clients. Each is a product choice with more than one good answer, and a template that picks one makes every other project undo it.

A new feature has to meet the five requirements in [ADR-0008](../docs/adr/0008-a-third-language-and-what-a-module-must-prove.md) and the checklist above.

## Versioning

The template is a product with a public contract, and its version says what a release does to the projects made from it.

**The public contract** is what adopters type and what a project records: the feature ids and preset names in `features.json`, init's flags (`--name`, `--owner`, `--repo`, `--description`, `--preset`, `--features`, `--out`), `template-update.mjs`'s flags (`--to`, `--add`, `--remove`, `--dry-run`, `--template`, `--owner`, `--repo`), the `Initialized from` and `Updated to` lines in `CHANGELOG.md` that `template-update.mjs` writes and reads back (an `Updated to` line names the features when an update changed them, and the newest line that names them is the selection), and the required check's name, `verify`. `template/init.test.mjs` fails if a 1.x feature or preset disappears.

| Bump | When | Example |
|---|---|---|
| **Major** | A generated project, or a person using the template, has to change something of their own to keep working | Removing or renaming a feature or preset, changing init's flags or the origin line, renaming the required check |
| **Minor** | A new capability, with nothing an existing project has to adapt to | A new feature, preset, script or check |
| **Patch** | Maintenance: fixes, pin updates, documentation, CI | A bug fix in a check, a Dependabot update, a clearer README |

A behaviour change a project's users would notice — an API status code, a stricter check — is at least minor, even when it fixes a bug, and its release notes say so.

## Releasing the template

"Use this template" copies `main` as it is, not the latest release, and init writes `version` from `features.json` into every new project as the release it came from. So **`main` always equals a published release**: a pull request that bumps `version` is released the moment it merges, by `.github/workflows/template-release.yml`, which tags that commit and writes notes with `release-notes.mjs` — what changes in a project made from each preset, generated at both releases with each release's own init and compared, then how to take it with `template-update.mjs`, then the merged pull requests. Diffing generated projects rather than the template is what makes the list true: a change inside a marker block reaches only the presets that keep it, and a file whose ownership moves is deleted from the presets that lose it without its contents changing at all. Nothing needs running by hand; `gh release view v<version>` shows the result.

Before merging a release pull request:

1. **Choose the bump** from the table above, and set `version` in `features.json` in the same pull request.
2. **Every preset generates and verifies.** `template-test` does this on the pull request, initializing in place on a fresh checkout as an adopter does. Do not merge on a red preset.
3. **Nothing of the template survives initialization.** Checked in every preset by `check-hygiene` (no marker lines) and by the `template-test` step that fails if `template/` remains.
4. **The README's steps still work.** If the release changes anything *Start a project* or *Getting started* describes, follow those steps once from a fresh clone.
5. **`configure-github.mjs` does what its header says.** If the release touches it, run `--dry-run` against a scratch repository and read the requests, then apply them there.
6. **Manual pins are current.** `pins.yml` lists every tool pinned by hand beside its latest release; move one with `node scripts/tools.mjs bump`, as [docs/toolchain-updates.md](../docs/toolchain-updates.md) describes, at every minor release.
7. **The notes will read right.** A minor or major release carries `template/notes/v<version>.md`, which the notes put first: every check that can now turn an adopter's build red, and every file an update is likely to conflict on and why. A template test fails such a version without it. `node template/release-notes.mjs --to v<version>` prints the notes locally.

After it merges, read the published release once. An `Updated to` or `Initialized from` line in a project is only as useful as the notes it points at.

The template repository runs no release-please of its own: `RELEASE_ENABLED` stays unset here, because release-please is for projects generated from it.
