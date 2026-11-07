# architecture

The system's architecture as code, in [LikeC4](https://likec4.dev). Diagrams are views of one model, so they cannot drift apart from each other, and the model is checked in CI like any other source.

```bash
npm ci --ignore-scripts
npm run dev        # live preview of every view
npm run verify     # validate the model, run the model rules, build the static site
```

- `model/spec.c4` — the element kinds this model may use.
- `model/system.c4` — two systems: `product`, the system a generated project builds (people, services, web apps, and how they depend on each other), and `chassis`, this repository's own machinery — the `verify.mjs` gate, the `check-*.mjs` guards, the ADR records, the knowledge graph and the `template/init.mjs` generator (ADR-0044), with every tracked file outside the modules drawn as a link on a chassis element (ADR-0046–ADR-0048).
- `model/views.c4` — the diagrams: `index` (everything), `containers of product`, `machinery` (the chassis alone), and the dynamic view `taskMove` (what happens on a task move, and where an illegal move is refused; ADR-0049). Every runtime relationship of `product` must be a step of a dynamic view — `runtimeFlowDocumented` in `rules.mjs` fails when one is not.
- `rules.mjs` — rules the model must satisfy, such as "every element states its technology", "no service depends on a web app", "nothing crosses the chassis/product boundary except the generator", "no element floats without a relationship" (ADR-0045) and "every built element links to a file" (ADR-0046); `scripts/check-architecture.mjs` holds the model to the files on disk in both directions — modules, and every tracked file outside them (ADR-0046–ADR-0048); `test/model.test.mjs` runs them against the model and proves each one can fail on a hand-built `violating` model (ADR-0043).

`npm run verify` builds the static site, laying out views with Graphviz's `dot` and `unflatten` — the Dev Container and GitHub's Ubuntu runners provide them; on another machine, install Graphviz first.

Change the model in the same pull request as the structure it describes. To publish it, enable GitHub Pages with the *GitHub Actions* source and set the repository variable `PAGES_ENABLED=true`; `.github/workflows/architecture.yml` then deploys it on every push to `main`.

The VS Code extension `likec4.likec4-vscode` adds completion, navigation and previews.
