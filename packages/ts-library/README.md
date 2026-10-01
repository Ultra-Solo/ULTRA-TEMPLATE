# ts-library

A TypeScript library published to npm: an ES module with its own type declarations, a single entry in the `exports` map, and checks that the published package works as consumers will install it. The example code is the task status rules the services enforce, for clients that want to offer only moves the API accepts.

```ts
import { canTransition, nextStatuses, parseStatus } from "@ultra-solo/ultra-template";

nextStatuses(parseStatus(response.status)); // ["todo", "done"] for "in_progress"
```

## Check

After `npm install`:

<!-- generated:checks packages/ts-library -->
```bash
npm run verify   # lint, typecheck, test, build, check:package, check:install
```
<!-- /generated -->

- **`tsc`** type-checks sources and tests.
- **Tests** run the TypeScript sources directly under Node, which strips the types.
- **`npm run build`** emits `dist/` from `src/` only, with `isolatedDeclarations`: every export states its type, so declarations never depend on inference.
- **`publint --strict`** checks the package's `exports`, `files` and entry points.
- **`attw --pack`** checks, against the tarball `npm pack` would publish, that the types resolve the way TypeScript consumers will resolve them.
- **`scripts/check-install.mjs`** packs the package, installs the tarball into an empty project with `--ignore-scripts`, imports it by name, and fails unless it exports exactly what `dist/index.js` exports. The two checks above read the package; this one runs it.

## Publish

With the `release` feature, a merged release pull request publishes this package to npm at the release's version, with [provenance](https://docs.npmjs.com/generating-provenance-statements). No token is stored: npm trusts the workflow through OpenID Connect.

1. On npmjs.com, add a trusted publisher to the package: GitHub Actions, this repository, workflow `release.yml`, environment `npm`. The publish job runs in that GitHub environment, so its settings can also require a reviewer or allow only tags to publish. If npm does not accept a trusted publisher for a package that has never been published, publish the first version once by hand with `npm publish --access public`.
2. Set the repository variable `NPM_PUBLISH_ENABLED=true`.

npm scopes are lowercase. If your GitHub owner name has capitals, change `name` in `package.json` before the first release.
