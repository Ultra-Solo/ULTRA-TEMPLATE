# How the template works

Everything in `template/` is deleted when a project is initialized. This file is for whoever maintains ULTRA-TEMPLATE itself.

## Why initialization is a local script

GitHub's *Use this template* copies every file and accepts no parameters, so feature selection has to happen after the copy. It cannot run as a GitHub Actions job in the new repository: a push made with `GITHUB_TOKEN` may not create, change or delete anything under `.github/workflows/`, and initialization does all three. So `template/init.mjs` runs once, on the developer's machine, and the result is committed as one reviewable change.

It needs Git and has no package dependencies beyond Node <!-- generated:version .node-version -->26<!-- /generated -->, validates every argument before touching a file, builds the whole result in memory before writing any of it, and refuses to run in place on a dirty working tree, so `git checkout -- . && git clean -fd` always undoes it.

## Exact source and reconstruction

Initialization renders the committed template source at the exact commit it resolves upstream — the default branch's HEAD, or a commit pinned with `--source-commit` — rather than the template copy's files or its new history ([ADR-0041](../docs/adr/0041-remove-template-self-versioning.md): the template has no releases to wait for). The result records `.template-provenance.json` schema 2 with upstream URL, full SHA and the original identity, feature selection, description and copyright year. Keep that file committed.

For an offline mirror, pass `--source <local-git-path>`; `--source <local-git-path> --source-commit <full-sha>` pins an exact candidate commit. Commit the source first: neither mode renders uncommitted edits. Explicit sources are code trust decisions. The recorded SHA identifies committed code and detects a repointed source; it does not authenticate the publisher.

The updater verifies the saved baseline commit before either renderer runs, including already-current checks, and uses the recorded inputs after project renames. Its `--check` reports, without touching anything, whether a newer commit exists upstream, and exits 1 when one does. Legacy projects whose only baseline is a `CHANGELOG.md` origin line require a reviewed `--legacy-commit <full-sha>`; ambiguous main-derived projects need a manual repair. See [ADR-0023](../docs/adr/0023-reconstruct-projects-from-exact-source.md), amended by [ADR-0041](../docs/adr/0041-remove-template-self-versioning.md).

## The mechanisms

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

**Identity.** The template is a working project under a real identity — owner `Ultra-Solo`, repository `ULTRA-TEMPLATE`, name `ultra-template` — so it verifies green before anyone initializes it. Init replaces those three strings in text files, through placeholders so no replacement can rewrite another's output. Registry namespaces use lowercase owners. The license is the exception: its original copyright notice is preserved, and init adds the adopter's notice. Never write the active identity in a form that should survive initialization outside that attribution.

The three are not interchangeable, and the public contract says where each one lands. `--owner` and `--repo` are the GitHub repository: every link, every badge, and the README title, which is what a reader sees at the top of that repository. `--name` is the project: `package.json` names and the npm scope, which is `@owner/name` lowercased because npm rejects capitals. They differ whenever a repository is named for its deployment and the package for its import, so neither may stand in for the other.

**Fresh meta-history.** A generated project starts without the template's own history, per [ADR-0040](../docs/adr/0040-clean-generated-projects-of-template-meta-history.md): `docs/adr/` keeps only `README.md` and `0000-template.md`, links that pointed at dropped records keep their label as plain text (a row in the ADR index goes entirely), no `CHANGELOG.md` is created for the template, and the template-operational agent adapters are `templateOnly` paths, so they never ship. The template's identity survives only where attribution belongs: `.template-provenance.json` and the license notice.

## Adding a feature

1. **Create the module directory, self-contained:** its toolchain's manifest and lockfile, tests, a README, and a `module.json` saying what it is: its id (the feature's), its toolchain, the checks `verify` runs, and, where they apply, `coverage`, `dev`, `taskApi`, `facts`, `e2e` and `image` ([ADR-0014](../docs/adr/0014-modules-describe-themselves.md)). `scripts/modules.mjs` finds the module by that file, and setup, verify, the contract, the facts check and CI all read it; a `dev` key names the command that runs the module in development, which `scripts/dev.mjs` starts with the task service; `check-hygiene` fails a malformed one. A Node module's `biome.jsonc` extends the root one, its `verify` script starts with `npm run lint`, and its coverage writes `coverage/lcov.info`.
2. **Add the feature to `features.json`** with the paths it owns, and to the presets it belongs in. The template tests fail if a module is not owned by exactly one feature.
3. **Add its job to `.github/workflows/verify.yml`,** named after its id — a checkout, then `.github/actions/module` with that id — inside a marker block, and list it under `verify.needs` inside another. `check-hygiene` fails if the job is missing, named otherwise, or left out of the gate. The action reads the module's toolchain from its `module.json`, so no other workflow needs an edit, `template-test.yml` and `copilot-setup-steps.yml` included.
4. **Add its lines elsewhere,** each inside markers: its Dependabot entries, its lines in `README.md` and `AGENTS.md`, and its element in the architecture model, linking its README, with a relation to another module in an `a&b` block. `check-hygiene` fails if its Dependabot entry is missing, and `check-architecture` if its element is. A task service says how it starts under `taskApi` and must pass the contract, configuration cases included; a module that repeats a fact lists it under `facts` and prints it from a `facts` script; a client of the task API can declare an `e2e` check. Any of them owns `scripts/rules` in `features.json`, and `scripts/contract` too if it serves or calls the task API.
5. **Where its README restates a fact** — a port, a limit, a version — write a generated block instead of the value (`scripts/generate-docs.mjs`).
6. **Verify,** as described below. A new preset needs no workflow edit: `template-test.yml` reads the presets from `features.json`.

## Verifying a change to the template

```bash
node scripts/verify.mjs                          # the template as a project, every feature present
node template/init.mjs --preset minimal --name demo-app --owner octo-org --out ../demo-minimal
cd ../demo-minimal && git init -q && git add -A && node scripts/setup.mjs && git add -A && git commit -q -m "chore: initialize project" && node scripts/verify.mjs
```

The commit precedes `verify` because `check-safety` measures the change against `HEAD`, and a repository with no commit yet has none.

`template/init.test.mjs` checks the marker grammar, identity replacement, argument validation, that the manifest matches the tree, and that an initialized project has no template residue. `.github/workflows/template-test.yml` generates every preset in CI and runs each project's own `setup` and `verify`, which lints its workflows with the pinned actionlint and zizmor. The template's `verify.yml` calls that workflow and requires its result on pull requests, main pushes, and merge queue entries. Initialization removes the call and its dependency; the standalone weekly and manual preset runs remain available in the template.

There is no release check to run: the template carries no version, so the `template-test` preset matrix on the pull request is the gate for a candidate change.

## Scope

ULTRA-TEMPLATE is complete in product scope. It gives a project the things with no product opinion — one verification gate, a pinned supply chain, repository and documentation checks, agent guidance, releases, security scanning, and a set of services and packages that demonstrate one architecture in three languages. A change belongs in the template when it would be right for nearly every project made from it.

These stay decisions for each project, and are left out on purpose: deployment targets and infrastructure, databases and migrations, authentication, message queues, UI frameworks beyond the minimal React app, and desktop or mobile clients. Each is a product choice with more than one good answer, and a template that picks one makes every other project undo it.

A new feature has to meet the five requirements in [ADR-0008](../docs/adr/0008-a-third-language-and-what-a-module-must-prove.md) and the checklist above.

## Versioning

The template carries no version and publishes no releases ([ADR-0041](../docs/adr/0041-remove-template-self-versioning.md)). Provenance is a commit: init records the exact template commit it rendered from in `.template-provenance.json` (schema 2 — upstream URL, full SHA, original identity, feature selection, description, copyright year), and `scripts/template-update.mjs` moves a project forward commit to commit, refusing any target that does not descend from the recorded one.

**The public contract** is what adopters type and what a project records: the feature ids and preset names in `features.json`, init's flags (`--name`, `--owner`, `--repo`, `--description`, `--preset`, `--features`, `--out`, `--source`, `--source-commit`), `template-update.mjs`'s flags (`--to` with a commit or `latest`, `--add`, `--remove`, `--dry-run`, `--template`, `--name`, `--owner`, `--repo`, `--legacy-commit`, `--to-commit`), the machine-readable provenance schema, and the required check's name, `verify`.

## Updating a project from a later commit

`scripts/template-update.mjs` verifies the recorded baseline commit, renders what init would produce at that commit and at the target commit with the project's own identity and feature selection, and applies the difference as a three-way merge.

A template change lands as a merge on `main`; projects pick it up with `node scripts/template-update.mjs --to latest` when they want it.

The template repository runs no release-please of its own: `RELEASE_ENABLED` stays unset here, because release-please is for projects generated from it.
