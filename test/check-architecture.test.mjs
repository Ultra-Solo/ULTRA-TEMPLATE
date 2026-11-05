// The model check must be seen to fail: one that never meets a model out of step with the modules
// proves nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDrawn, checkModel, drawn, modelLinks } from "../scripts/check-architecture.mjs";

const modules = [
  { id: "api", dir: "services/api" },
  { id: "web", dir: "apps/web" },
  { id: "architecture", dir: "architecture" },
];
const model = (lines) => modelLinks([{ path: "architecture/model/system.c4", text: lines.join("\n") }]);
const both = [
  "  api = service 'api' {",
  "    link ../../services/api/README.md 'README'",
  "  }",
  "  web = webapp 'web' {",
  "    link ../../apps/web/README.md 'README'",
  "  }",
];

test("a model with one element per module agrees, and the model's own module needs none", () => {
  assert.deepEqual(checkModel(modules, model(both), "architecture/model"), []);
});

test("links are read relative to the file they are in, and a web address is not a module", () => {
  assert.deepEqual(
    model(["link ../../services/api/README.md 'README'", "link https://example.test/docs 'Docs'"]).map((l) => l.target),
    ["services/api/README.md"],
  );
});

test("a module missing from the model, a module drawn twice, and a prefix-sharing directory all fail", () => {
  assert.match(
    checkModel(modules, model(both.slice(0, 3)), "architecture/model").join(),
    /web \(apps\/web\) is here, but no element of the model links to apps\/web\/README\.md/,
  );
  assert.match(
    checkModel(modules, model([...both, "    link ../../apps/web/README.md 'README'"]), "architecture/model").join(),
    /web has 2 elements linking to apps\/web\/README\.md/,
  );
  // A directory that merely shares a prefix with the model's is still a module to draw.
  assert.match(
    checkModel([...modules, { id: "arch2", dir: "architecture-2" }], model(both), "architecture/model").join(),
    /arch2 \(architecture-2\) is here/,
  );
});

test("drawn keeps every file outside the modules and the ADR records, and keeps the two ADR seeds (ADR-0048)", () => {
  const dirs = ["services/api", "apps/web", "architecture"];
  assert.equal(drawn("README.md", dirs), true);
  assert.equal(drawn(".github/workflows/verify.yml", dirs), true);
  assert.equal(drawn("data/plan.md", dirs), true);
  assert.equal(drawn("docs/adr/README.md", dirs), true);
  assert.equal(drawn("docs/adr/0000-template.md", dirs), true);
  assert.equal(drawn("docs/adr/0048-draw-every-tracked-file-outside-the-modules-in-the-model.md", dirs), false);
  assert.equal(drawn("services/api/README.md", dirs), false);
  assert.equal(drawn("architecture/model/system.c4", dirs), false);
  // The generator writes this into every generated project (ADR-0023); it is not template content.
  assert.equal(drawn(".template-provenance.json", dirs), false);
  // A directory that merely shares a prefix with a module dir is not inside it.
  assert.equal(drawn("services/api2/x.mjs", dirs), true);
});

const files = ["README.md", "data/plan.md", ".github/workflows/verify.yml", "scripts/verify.mjs", "docs/adr/README.md"];
const all = [...files, "services/api/README.md", "docs/adr/0048-draw-every-tracked-file-outside-the-modules-in-the-model.md"];

test("a model that links every drawn file here agrees; module files and ADR records need no link but may be linked (ADR-0046–ADR-0048)", () => {
  const links = model([
    "    link ../../README.md 'README'",
    "    link ../../data/plan.md 'plan.md'",
    "    link ../../.github/workflows/verify.yml 'verify.yml'",
    "    link ../../scripts/verify.mjs 'verify.mjs'",
    "    link ../../docs/adr/README.md 'index'",
    "    link ../../services/api/README.md 'README'",
  ]);
  assert.deepEqual(checkDrawn(files, links, all), []);
});

test("a file nobody draws, and a link to a file that is gone — a README included — both fail (ADR-0048)", () => {
  const linked = model(["    link ../../README.md 'README'", "    link ../../scripts/verify.mjs 'verify.mjs'"]);
  assert.match(checkDrawn(files, linked, all).join(), /data\/plan\.md is here, but no element of the model links to it/);
  assert.match(checkDrawn(files, linked, all).join(), /\.github\/workflows\/verify\.yml is here, but no element of the model links to it/);
  assert.match(checkDrawn(files, linked, all).join(), /docs\/adr\/README\.md is here, but no element of the model links to it/);
  assert.match(
    checkDrawn(
      ["README.md"],
      [...model(["    link ../../README.md 'README'"]), ...model(["    link ../../services/gone/README.md 'README'"])],
      all,
    ).join(),
    /system\.c4:\d+ links to services\/gone\/README\.md, which is not a file here/,
  );
});
