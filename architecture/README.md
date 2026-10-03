# architecture

The system's architecture as code, in [LikeC4](https://likec4.dev). Diagrams are views of one model, so they cannot drift apart from each other, and the model is checked in CI like any other source.

```bash
npm ci --ignore-scripts
npm run dev        # live preview of every view
npm run verify     # validate the model, run the model rules, build the static site
```

- `model/spec.c4` — the element kinds this model may use.
- `model/system.c4` — the system: people, services, web apps, and how they depend on each other.
- `model/views.c4` — the diagrams.
- `rules.mjs` — rules the model must satisfy, such as "every service states its technology" and "no service depends on a web app"; `test/model.test.mjs` runs them against the model and proves each one can fail.

`npm run verify` builds the static site, laying out views with Graphviz's `dot` and `unflatten` — the Dev Container and GitHub's Ubuntu runners provide them; on another machine, install Graphviz first.

Change the model in the same pull request as the structure it describes. To publish it, enable GitHub Pages with the *GitHub Actions* source and set the repository variable `PAGES_ENABLED=true`; `.github/workflows/architecture.yml` then deploys it on every push to `main`.

The VS Code extension `likec4.likec4-vscode` adds completion, navigation and previews.
